import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/visit_schedules_api.dart';

// Colors ported 1:1 from temp_images/Mzazi Care Caregiver App Wireframes.dc.html's #m3b section -
// this app has no design-system package, so tokens are plain consts instead of a theme extension.
const _primaryGreen = Color(0xFF047857);
const _successGreen = Color(0xFF15B042);
const _dangerRed = Color(0xFFE0392B);
const _inkDark = Color(0xFF292929);
const _inkMid = Color(0xFF525252);
const _inkLight = Color(0xFF9E9E9E);
const _dimDay = Color(0xFFC9C9C9);
const _dividerColor = Color(0xFFF0F0F0);
const _borderColor = Color(0xFFE5E5E5);

const _monthNames = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const _weekdayShort = [
  'S',
  'M',
  'T',
  'W',
  'T',
  'F',
  'S',
]; // header row, Sun-first
// Indexed 0=Sunday..6=Saturday to match DateTime.weekday % 7 (DateTime.weekday is 1=Mon..7=Sun).
const _weekdayFullUpper = [
  'SUNDAY',
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
];

/// 03b - Schedule Calendar. Fetches the signed-in caregiver's visits (server already scopes
/// GET /visit-schedules to the caller - no caregiverId param), then renders a month grid plus a
/// bottom sheet of the selected day's visits, per the wireframe.
class ScheduleCalendarScreen extends StatefulWidget {
  final VisitSchedulesApi visitSchedulesApi;
  final void Function(VisitSchedule visit) onSelectVisit;
  // Bumped by the shell whenever a visit flow (check-in, checkout) returns, so the calendar
  // re-fetches statuses instead of showing the pre-visit ones.
  final int refreshToken;

  const ScheduleCalendarScreen({
    super.key,
    required this.visitSchedulesApi,
    required this.onSelectVisit,
    this.refreshToken = 0,
  });

  @override
  State<ScheduleCalendarScreen> createState() => _ScheduleCalendarScreenState();
}

class _ScheduleCalendarScreenState extends State<ScheduleCalendarScreen> {
  bool _loading = true;
  String? _error;
  List<VisitSchedule> _visits = [];
  late DateTime _focusedMonth;
  late DateTime _selectedDay;

  @override
  void initState() {
    super.initState();
    final now = DateTime.now();
    _focusedMonth = DateTime(now.year, now.month);
    _selectedDay = DateTime(now.year, now.month, now.day);
    _loadVisits();
  }

  @override
  void didUpdateWidget(ScheduleCalendarScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.refreshToken != widget.refreshToken) {
      _loadVisits(showSpinner: false);
    }
  }

  Future<void> _loadVisits({bool showSpinner = true}) async {
    setState(() {
      _loading = showSpinner;
      _error = null;
    });
    try {
      // POC scale: one generously-sized page (limit 100), no date filtering. Month navigation
      // below is purely client-side over this one fetch - fine until a caregiver has more than
      // ~100 visits outstanding, at which point this should become a per-month refetch.
      final page = await widget.visitSchedulesApi.listVisitSchedules(
        const ListVisitSchedulesParams(limit: 100),
      );
      if (!mounted) return;
      setState(() {
        _visits = page.items;
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.problem.detail ?? e.problem.title;
        _loading = false;
      });
    }
  }

  bool _isSameDay(DateTime a, DateTime b) =>
      a.year == b.year && a.month == b.month && a.day == b.day;

  List<VisitSchedule> _visitsOn(DateTime day) {
    final matches = _visits
        .where((v) => _isSameDay(v.scheduledStart, day))
        .toList();
    matches.sort((a, b) => a.scheduledStart.compareTo(b.scheduledStart));
    return matches;
  }

  void _changeMonth(int delta) {
    setState(() {
      _focusedMonth = DateTime(_focusedMonth.year, _focusedMonth.month + delta);
      _selectedDay = DateTime(_focusedMonth.year, _focusedMonth.month, 1);
    });
  }

  void _selectDay(DateTime day) {
    setState(() {
      _selectedDay = day;
      if (day.month != _focusedMonth.month || day.year != _focusedMonth.year) {
        _focusedMonth = DateTime(day.year, day.month);
      }
    });
  }

  // Sun-first 7-wide grid: leading days from the previous month fill the first row, trailing
  // days from the next month fill the last, so the grid is always a whole number of weeks.
  List<DateTime> _calendarDays() {
    final firstOfMonth = DateTime(_focusedMonth.year, _focusedMonth.month, 1);
    final leading =
        firstOfMonth.weekday % 7; // DateTime.weekday: Mon=1..Sun=7, so Sun%7=0
    final daysInMonth = DateTime(
      _focusedMonth.year,
      _focusedMonth.month + 1,
      0,
    ).day;
    final gridStart = firstOfMonth.subtract(Duration(days: leading));
    final totalCells = ((leading + daysInMonth) / 7).ceil() * 7;
    return List.generate(totalCells, (i) => gridStart.add(Duration(days: i)));
  }

  String _formatTime(DateTime dt) {
    final hour12 = dt.hour % 12 == 0 ? 12 : dt.hour % 12;
    final minute = dt.minute.toString().padLeft(2, '0');
    final period = dt.hour < 12 ? 'AM' : 'PM';
    return '$hour12:$minute $period';
  }

  static bool _isMissed(String status) =>
      status == 'missed' || status == 'investigated';

  // scheduled/in_progress, and any future status the client doesn't know yet, fall to the primary green.
  Color _statusDotColor(String status) => switch (status) {
    'completed' => _successGreen,
    'cancelled' || 'missed' || 'investigated' => _dangerRed,
    _ => _primaryGreen,
  };

  // A day's circle (user spec 2026-09-24): red if any visit that day was missed, green once every
  // visit is completed, otherwise the primary green. Cancelled visits don't count; null = no visits to show.
  Color? _dayColor(DateTime day) {
    final visits = _visitsOn(day).where((v) => v.status != 'cancelled');
    if (visits.isEmpty) return null;
    if (visits.any((v) => _isMissed(v.status))) return _dangerRed;
    if (visits.every((v) => v.status == 'completed')) return _successGreen;
    return _primaryGreen;
  }

  // Same wording as the admin web app's Visits page for the two check-in states.
  String _statusLabel(String status) => switch (status) {
    'in_progress' => 'Checked in',
    'completed' => 'Checked out',
    '' => status,
    _ =>
      '${status[0].toUpperCase()}${status.substring(1).replaceAll('_', ' ')}',
  };

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.white,
      body: SafeArea(
        child: _loading
            ? const Center(
                child: CircularProgressIndicator(color: _primaryGreen),
              )
            : _error != null
            ? _buildError()
            : _buildCalendar(),
      ),
    );
  }

  Widget _buildError() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              _error!,
              style: const TextStyle(color: _inkMid, fontSize: 14),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 12),
            TextButton(onPressed: _loadVisits, child: const Text('Retry')),
          ],
        ),
      ),
    );
  }

  Widget _buildCalendar() {
    final days = _calendarDays();
    final selectedVisits = _visitsOn(_selectedDay);

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 20, 20, 16),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Row(
                children: [
                  Text(
                    _monthNames[_focusedMonth.month - 1],
                    style: const TextStyle(
                      fontSize: 18,
                      fontWeight: FontWeight.w500,
                      color: _inkDark,
                    ),
                  ),
                  const SizedBox(width: 10),
                  IconButton(
                    icon: const Icon(
                      Icons.chevron_left,
                      size: 18,
                      color: _inkLight,
                    ),
                    padding: EdgeInsets.zero,
                    constraints: const BoxConstraints(
                      minWidth: 24,
                      minHeight: 24,
                    ),
                    onPressed: () => _changeMonth(-1),
                  ),
                  IconButton(
                    icon: const Icon(
                      Icons.chevron_right,
                      size: 18,
                      color: _inkDark,
                    ),
                    padding: EdgeInsets.zero,
                    constraints: const BoxConstraints(
                      minWidth: 24,
                      minHeight: 24,
                    ),
                    onPressed: () => _changeMonth(1),
                  ),
                ],
              ),
              // New-visit shortcut from the wireframe, deliberately inert: scheduling a visit is
              // supervisor-only server-side (a different app entirely) - there is no caregiver
              // create flow to wire this to.
              Container(
                width: 32,
                height: 32,
                decoration: const BoxDecoration(
                  shape: BoxShape.rectangle,
                  border: Border.fromBorderSide(
                    BorderSide(color: _borderColor),
                  ),
                ),
                child: const Icon(Icons.add, size: 16, color: _inkMid),
              ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 20),
          child: Row(
            children: _weekdayShort
                .map(
                  (d) => Expanded(
                    child: Center(
                      child: Text(
                        d,
                        style: const TextStyle(fontSize: 11, color: _inkLight),
                      ),
                    ),
                  ),
                )
                .toList(),
          ),
        ),
        const SizedBox(height: 6),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 20),
          child: GridView.count(
            crossAxisCount: 7,
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            childAspectRatio: 1.1,
            children: days.map(_buildDayCell).toList(),
          ),
        ),
        Expanded(
          child: Container(
            margin: const EdgeInsets.only(top: 14),
            decoration: const BoxDecoration(
              color: Colors.white,
              border: Border(top: BorderSide(color: _dividerColor)),
              borderRadius: BorderRadius.zero,
              boxShadow: [
                BoxShadow(
                  color: Color(0x0A000000),
                  blurRadius: 24,
                  offset: Offset(0, -8),
                ),
              ],
            ),
            child: Column(
              children: [
                const SizedBox(height: 10),
                Container(
                  width: 36,
                  height: 4,
                  decoration: BoxDecoration(
                    color: _borderColor,
                    borderRadius: BorderRadius.zero,
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 12, 20, 8),
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: Text(
                      '${_weekdayFullUpper[_selectedDay.weekday % 7]} ${_selectedDay.day}',
                      style: const TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w500,
                        color: _inkLight,
                        letterSpacing: 0.4,
                      ),
                    ),
                  ),
                ),
                Expanded(
                  child: selectedVisits.isEmpty
                      ? const Center(
                          child: Text(
                            'No visits scheduled',
                            style: TextStyle(fontSize: 13, color: _inkLight),
                          ),
                        )
                      : ListView.builder(
                          padding: const EdgeInsets.symmetric(horizontal: 20),
                          itemCount: selectedVisits.length,
                          itemBuilder: (context, i) =>
                              _buildVisitRow(selectedVisits[i]),
                        ),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildDayCell(DateTime day) {
    final isCurrentMonth =
        day.month == _focusedMonth.month && day.year == _focusedMonth.year;
    final isSelected = _isSameDay(day, _selectedDay);
    final dayColor = isCurrentMonth ? _dayColor(day) : null;

    Widget circle;
    if (isSelected) {
      circle = Container(
        width: 32,
        height: 32,
        decoration: BoxDecoration(
          color: dayColor ?? _primaryGreen,
          shape: BoxShape.rectangle,
        ),
        alignment: Alignment.center,
        child: Text(
          '${day.day}',
          style: const TextStyle(fontSize: 13, color: Colors.white),
        ),
      );
    } else if (!isCurrentMonth) {
      circle = SizedBox(
        width: 32,
        height: 32,
        child: Center(
          child: Text(
            '${day.day}',
            style: const TextStyle(fontSize: 13, color: _dimDay),
          ),
        ),
      );
    } else if (dayColor != null) {
      circle = Container(
        width: 32,
        height: 32,
        decoration: BoxDecoration(
          shape: BoxShape.rectangle,
          border: Border.all(color: dayColor, width: 1.5),
        ),
        alignment: Alignment.center,
        child: Text(
          '${day.day}',
          style: const TextStyle(fontSize: 13, color: _inkDark),
        ),
      );
    } else {
      circle = SizedBox(
        width: 32,
        height: 32,
        child: Center(
          child: Text(
            '${day.day}',
            style: const TextStyle(fontSize: 13, color: _inkDark),
          ),
        ),
      );
    }

    return InkWell(
      onTap: () => _selectDay(DateTime(day.year, day.month, day.day)),
      customBorder: const RoundedRectangleBorder(),
      child: Center(child: circle),
    );
  }

  Widget _buildVisitRow(VisitSchedule visit) {
    final timeRange =
        '${_formatTime(visit.scheduledStart)} - ${_formatTime(visit.scheduledEnd)}';
    return InkWell(
      onTap: () => widget.onSelectVisit(visit),
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 10),
        decoration: const BoxDecoration(
          border: Border(bottom: BorderSide(color: _dividerColor)),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              width: 44,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    _formatTime(visit.scheduledStart),
                    style: const TextStyle(fontSize: 11, color: _inkLight),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    _formatTime(visit.scheduledEnd),
                    style: const TextStyle(fontSize: 11, color: _inkLight),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 12),
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Container(
                width: 8,
                height: 8,
                decoration: BoxDecoration(
                  color: _statusDotColor(visit.status),
                  shape: BoxShape.rectangle,
                ),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    visit.dependantDisplayName,
                    style: const TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w500,
                      color: _inkDark,
                    ),
                  ),
                  Text(
                    '$timeRange · ${_statusLabel(visit.status)}',
                    style: const TextStyle(fontSize: 12, color: _inkLight),
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
