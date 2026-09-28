import 'package:flutter/material.dart';

import '../api/dependants_api.dart';
import '../api/visit_schedules_api.dart';
import '../app_ui.dart';
import '../widgets/visit_widgets.dart';

/// A scheduled visit that hasn't started: who is coming, when, where, and what they'll do.
/// The care activities are the dependant's current care plan - the plan is kept per dependant,
/// not per visit, so every upcoming visit shows the same list.
class UpcomingVisitScreen extends StatefulWidget {
  final VisitSchedule visit;
  final Dependant dependant;
  final DependantsApi dependantsApi;

  const UpcomingVisitScreen({
    super.key,
    required this.visit,
    required this.dependant,
    required this.dependantsApi,
  });

  @override
  State<UpcomingVisitScreen> createState() => _UpcomingVisitScreenState();
}

class _UpcomingVisitScreenState extends State<UpcomingVisitScreen> {
  List<CareTask>? _tasks;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final tasks = await widget.dependantsApi.listActiveCareTasks(
        widget.dependant.id,
      );
      if (mounted) setState(() => _tasks = tasks);
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    final visit = widget.visit;
    final dependant = widget.dependant;
    final address = [
      ?dependant.homeAddressText,
      ?dependant.areaText,
    ].join('\n');

    return Scaffold(
      backgroundColor: const Color(0xFFF7F7F7),
      appBar: AppBar(
        backgroundColor: Colors.white,
        surfaceTintColor: Colors.white,
        title: const Text('Scheduled visit', style: TextStyle(fontSize: 16)),
      ),
      body: constrainedContent(
        RefreshIndicator(
          onRefresh: _load,
          child: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              SectionCard(
                child: Column(
                  children: [
                    _DetailRow(
                      icon: Icons.person_outline,
                      label: 'Caregiver',
                      value: visit.caregiverDisplayName,
                    ),
                    const Divider(height: 1, color: borderColor),
                    _DetailRow(
                      icon: Icons.schedule,
                      label: 'Time',
                      value: formatVisitWindow(context, visit),
                    ),
                    const Divider(height: 1, color: borderColor),
                    _DetailRow(
                      icon: Icons.home_outlined,
                      label: 'Address',
                      value: address.isEmpty ? 'No address given' : address,
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 8),
              const SectionTitle('Care activities'),
              _buildTasks(),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildTasks() {
    if (_error != null) {
      return SectionCard(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            Text(_error!, style: const TextStyle(color: inkSecondary)),
            TextButton(onPressed: _load, child: const Text('Retry')),
          ],
        ),
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
      return const SectionCard(
        padding: EdgeInsets.all(16),
        child: Text(
          'No care activities have been set up yet.',
          style: TextStyle(color: inkTertiary),
        ),
      );
    }
    return SectionCard(
      child: Column(
        children: [
          for (final (i, task) in tasks.indexed) ...[
            if (i > 0) const Divider(height: 1, color: borderColor),
            ListTile(
              leading: const Icon(
                Icons.check_box_outline_blank,
                color: inkTertiary,
              ),
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

class _DetailRow extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;

  const _DetailRow({
    required this.icon,
    required this.label,
    required this.value,
  });

  @override
  Widget build(BuildContext context) => ListTile(
    leading: Icon(icon, color: inkSecondary),
    title: Text(
      label,
      style: const TextStyle(fontSize: 12, color: inkTertiary),
    ),
    subtitle: Text(
      value,
      style: const TextStyle(fontSize: 14, color: inkDefault),
    ),
  );
}
