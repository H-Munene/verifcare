import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/visit_schedules_api.dart';
import '../app_ui.dart';
import '../widgets/visit_audio_recorder.dart';
import 'checkout_screen.dart';

/// The checked-in visit: the care-plan checklist plus the audio log. Everything shown here is
/// re-read from the server (ticks) or disk (audio) on open, so this same screen is what the
/// ongoing-visit banner and notification reopen after the app was closed.
class VisitInProgressScreen extends StatefulWidget {
  final VisitSchedule visit;
  final VisitSchedulesApi visitSchedulesApi;

  const VisitInProgressScreen({
    super.key,
    required this.visit,
    required this.visitSchedulesApi,
  });

  @override
  State<VisitInProgressScreen> createState() => _VisitInProgressScreenState();
}

class _VisitInProgressScreenState extends State<VisitInProgressScreen> {
  List<VisitTask>? _tasks;
  String? _error;
  final _checked = <String>{};
  bool _hasRecording = false;

  @override
  void initState() {
    super.initState();
    _loadTasks();
  }

  Future<void> _loadTasks() async {
    setState(() => _error = null);
    try {
      final tasks = await widget.visitSchedulesApi.listTasks(widget.visit.id);
      if (!mounted) return;
      setState(() {
        _tasks = tasks;
        _checked
          ..clear()
          ..addAll(
            tasks
                .where((t) => t.status == 'completed')
                .map((t) => t.careTaskId),
          );
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.problem.detail ?? e.problem.title);
    }
  }

  // Ticking saves straight away so it survives the app closing. Unticking stays local: the API
  // has no "unrecorded" state to go back to, and checkout re-saves every task (with a reason for
  // each unticked one) anyway.
  Future<void> _toggle(VisitTask task, bool checked) async {
    setState(
      () => checked
          ? _checked.add(task.careTaskId)
          : _checked.remove(task.careTaskId),
    );
    if (!checked) return;
    try {
      await widget.visitSchedulesApi.putTask(
        widget.visit.id,
        task.careTaskId,
        status: 'completed',
      );
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _checked.remove(task.careTaskId));
      showSnack(context, e.problem.detail ?? 'Could not save "${task.title}".');
    }
  }

  void _openCheckout() {
    final tasks = _tasks;
    if (tasks == null) return;
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => CheckoutScreen(
          visit: widget.visit,
          visitSchedulesApi: widget.visitSchedulesApi,
          tasks: tasks,
          checkedTaskIds: Set.of(_checked),
          hasRecording: _hasRecording,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF7F7F7),
      appBar: AppBar(
        backgroundColor: Colors.white,
        surfaceTintColor: Colors.white,
        title: Text(
          widget.visit.dependantDisplayName,
          style: const TextStyle(fontSize: 16),
        ),
        actions: [
          Padding(
            padding: const EdgeInsets.only(right: 8),
            child: TextButton(
              onPressed: _tasks == null ? null : _openCheckout,
              child: const Text('Check out'),
            ),
          ),
        ],
      ),
      body: LayoutBuilder(
        builder: (context, constraints) {
          final checklist = [
            const _SectionTitle('Checklist'),
            _buildChecklist(),
          ];
          final audio = [
            const _SectionTitle('Audio log'),
            VisitAudioRecorder(
              key: _recorderKey,
              visitScheduleId: widget.visit.id,
              onRecordingChanged: (has) => setState(() => _hasRecording = has),
            ),
          ];
          if (constraints.maxWidth < _twoColumnMinWidth) {
            return constrainedContent(
              ListView(
                padding: const EdgeInsets.all(16),
                children: [...checklist, const SizedBox(height: 24), ...audio],
              ),
            );
          }
          return Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.all(16),
                  children: checklist,
                ),
              ),
              SizedBox(
                width: 400,
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(0, 16, 16, 16),
                  children: audio,
                ),
              ),
            ],
          );
        },
      ),
    );
  }

  // Tablets / landscape get checklist and recorder side by side. The GlobalKey keeps the
  // recorder's state (including a recording in progress) when a rotation swaps layouts.
  static const _twoColumnMinWidth = 840.0;
  final _recorderKey = GlobalKey();

  Widget _buildChecklist() {
    if (_error != null) {
      return Column(
        children: [
          Text(_error!, style: const TextStyle(color: inkSecondary)),
          TextButton(onPressed: _loadTasks, child: const Text('Retry')),
        ],
      );
    }
    final tasks = _tasks;
    if (tasks == null) {
      return const Padding(
        padding: EdgeInsets.all(24),
        child: Center(child: CircularProgressIndicator()),
      );
    }
    if (tasks.isEmpty) {
      return const Text(
        'No care-plan tasks for this dependant.',
        style: TextStyle(color: inkTertiary),
      );
    }
    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.zero,
        border: Border.all(color: borderColor),
      ),
      child: Column(
        children: [
          for (final (i, task) in tasks.indexed) ...[
            if (i > 0) const Divider(height: 1, color: borderColor),
            CheckboxListTile(
              value: _checked.contains(task.careTaskId),
              onChanged: (value) => _toggle(task, value ?? false),
              controlAffinity: ListTileControlAffinity.leading,
              activeColor: successGreen,
              title: Text(task.title, style: const TextStyle(fontSize: 14)),
              subtitle: task.description == null && !task.required
                  ? null
                  : Text(
                      [
                        ?task.description,
                        if (task.required) 'Required',
                      ].join(' · '),
                      style: const TextStyle(fontSize: 12, color: inkTertiary),
                    ),
            ),
          ],
        ],
      ),
    );
  }
}

class _SectionTitle extends StatelessWidget {
  final String text;
  const _SectionTitle(this.text);

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(left: 4, bottom: 8),
    child: Text(
      text,
      style: const TextStyle(
        fontSize: 13,
        fontWeight: FontWeight.w500,
        color: inkSecondary,
      ),
    ),
  );
}
