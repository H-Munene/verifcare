import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/visit_schedules_api.dart';
import '../app_ui.dart';
import '../visit_notifications.dart';

// visit_task_completions.reason's enum (backend/src/db/schema.ts taskSkipReasonEnum).
const _skipReasons = {
  'client_declined': 'Client declined',
  'client_unavailable': 'Client unavailable',
  'equipment_unavailable': 'Equipment unavailable',
  'other': 'Other',
};

/// Review before checkout: every unticked task needs a reason before the button enables (for
/// optional tasks too, per the user's own spec - stricter than the server, which only gates on
/// required ones). The audio log shows as present/absent but never blocks checkout.
class CheckoutScreen extends StatefulWidget {
  final VisitSchedule visit;
  final VisitSchedulesApi visitSchedulesApi;
  final List<VisitTask> tasks;
  final Set<String> checkedTaskIds;
  final bool hasRecording;

  const CheckoutScreen({
    super.key,
    required this.visit,
    required this.visitSchedulesApi,
    required this.tasks,
    required this.checkedTaskIds,
    required this.hasRecording,
  });

  @override
  State<CheckoutScreen> createState() => _CheckoutScreenState();
}

class _CheckoutScreenState extends State<CheckoutScreen> {
  final _reasons = <String, String>{};
  final _notes = <String, TextEditingController>{};
  bool _submitting = false;

  List<VisitTask> get _unchecked => widget.tasks
      .where((t) => !widget.checkedTaskIds.contains(t.careTaskId))
      .toList();

  bool get _canSubmit =>
      !_submitting &&
      _unchecked.every((t) => _reasons.containsKey(t.careTaskId));

  @override
  void dispose() {
    for (final controller in _notes.values) {
      controller.dispose();
    }
    super.dispose();
  }

  Future<void> _checkout() async {
    setState(() => _submitting = true);
    try {
      // Re-save every task, not just the unticked ones, so the server's record is exactly what
      // this screen showed (a tick that failed to save earlier gets another chance here).
      await Future.wait(
        widget.tasks.map((task) {
          final checked = widget.checkedTaskIds.contains(task.careTaskId);
          final notes = _notes[task.careTaskId]?.text.trim();
          return widget.visitSchedulesApi.putTask(
            widget.visit.id,
            task.careTaskId,
            status: checked ? 'completed' : 'not_completed',
            reason: checked ? null : _reasons[task.careTaskId],
            notes: checked || notes == null || notes.isEmpty ? null : notes,
          );
        }),
      );
      await widget.visitSchedulesApi.checkout(widget.visit.id);
      await VisitNotifications.showCheckedOut(widget.visit);
      if (!mounted) return;
      Navigator.of(context).popUntil((route) => route.isFirst);
    } catch (e) {
      if (!mounted) return;
      setState(() => _submitting = false);
      showSnack(
        context,
        e is ApiException
            ? (e.problem.detail ?? e.problem.title)
            : 'Could not reach the server - try again.',
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF7F7F7),
      appBar: AppBar(
        backgroundColor: Colors.white,
        surfaceTintColor: Colors.white,
        title: const Text('Check out', style: TextStyle(fontSize: 16)),
      ),
      body: constrainedContent(
        ListView(
          padding: const EdgeInsets.all(16),
          children: [
            _card([
              for (final (i, task) in widget.tasks.indexed) ...[
                if (i > 0) const Divider(height: 1, color: borderColor),
                _buildTaskRow(task),
              ],
              if (widget.tasks.isEmpty)
                const Padding(
                  padding: EdgeInsets.all(16),
                  child: Text(
                    'No care-plan tasks for this visit.',
                    style: TextStyle(color: inkTertiary),
                  ),
                ),
            ]),
            const SizedBox(height: 16),
            _card([
              _statusRow(
                done: widget.hasRecording,
                title: widget.hasRecording
                    ? 'Audio log recorded'
                    : 'No audio log recorded',
                subtitle: 'Kept on this phone for now - not uploaded yet',
              ),
            ]),
          ],
        ),
      ),
      bottomNavigationBar: SafeArea(
        child: constrainedContent(
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
            child: ElevatedButton(
              onPressed: _canSubmit ? _checkout : null,
              style: pillButtonStyle,
              child: _submitting
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: Colors.white,
                      ),
                    )
                  : const Text('Check out'),
            ),
          ),
        ),
      ),
    );
  }

  Widget _card(List<Widget> children) => Container(
    decoration: BoxDecoration(
      color: Colors.white,
      borderRadius: BorderRadius.circular(16),
      border: Border.all(color: borderColor),
    ),
    child: Column(children: children),
  );

  Widget _statusRow({
    required bool done,
    required String title,
    String? subtitle,
  }) => ListTile(
    leading: Icon(
      done ? Icons.check_circle : Icons.cancel,
      color: done ? successGreen : dangerRed,
    ),
    title: Text(title, style: const TextStyle(fontSize: 14)),
    subtitle: subtitle == null
        ? null
        : Text(
            subtitle,
            style: const TextStyle(fontSize: 12, color: inkTertiary),
          ),
  );

  Widget _buildTaskRow(VisitTask task) {
    final checked = widget.checkedTaskIds.contains(task.careTaskId);
    if (checked) return _statusRow(done: true, title: task.title);

    final reason = _reasons[task.careTaskId];
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        children: [
          _statusRow(done: false, title: task.title),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: DropdownButtonFormField<String>(
              initialValue: reason,
              decoration: const InputDecoration(
                labelText: 'Reason not done',
                border: OutlineInputBorder(),
                isDense: true,
              ),
              items: [
                for (final entry in _skipReasons.entries)
                  DropdownMenuItem(value: entry.key, child: Text(entry.value)),
              ],
              onChanged: _submitting
                  ? null
                  : (value) =>
                        setState(() => _reasons[task.careTaskId] = value!),
            ),
          ),
          if (reason == 'other')
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
              child: TextField(
                controller: _notes.putIfAbsent(
                  task.careTaskId,
                  TextEditingController.new,
                ),
                enabled: !_submitting,
                decoration: const InputDecoration(
                  labelText: 'Details (optional)',
                  border: OutlineInputBorder(),
                  isDense: true,
                ),
              ),
            ),
        ],
      ),
    );
  }
}
