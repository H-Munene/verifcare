import 'dart:async';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../api/biometric_enrollments_api.dart';
import '../api/dependants_api.dart';
import '../api/family_link_requests_api.dart';
import '../api/users_api.dart';
import '../api/visit_schedules_api.dart';
import '../app_ui.dart';
import '../auth/cognito_auth_service.dart';
import '../feed/visit_feed.dart';
import '../widgets/link_requests_sheet.dart';
import '../widgets/states.dart';
import '../widgets/visit_widgets.dart';
import 'dependant_wizard_screen.dart';
import 'join_family_screen.dart';
import 'tabs/account_tab.dart';
import 'tabs/family_tab.dart';
import 'tabs/today_tab.dart';
import 'tabs/visits_tab.dart';

/// The signed-in app (2026-10-12 redesign, "today first", after Birdie's and Honor's family apps):
/// one dependant at a time, picked from the app bar and remembered between launches, with four
/// tabs - Today (what's happening now and recently), Visits, Family and Account. The bell holds
/// family link requests: ones waiting for the caller's answer as a primary contact, and the
/// outcome of the caller's own.
class HomeScreen extends StatefulWidget {
  final CognitoAuthService authService;
  final DependantsApi dependantsApi;
  final VisitSchedulesApi visitSchedulesApi;
  final BiometricEnrollmentsApi enrollmentsApi;
  final UsersApi usersApi;
  final FamilyLinkRequestsApi linkRequestsApi;
  final IdentityClaims identity;
  final VoidCallback onSignedOut;

  const HomeScreen({
    super.key,
    required this.authService,
    required this.dependantsApi,
    required this.visitSchedulesApi,
    required this.enrollmentsApi,
    required this.usersApi,
    required this.linkRequestsApi,
    required this.identity,
    required this.onSignedOut,
  });

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

const _selectedDependantKey = 'family.selectedDependantId';

class _HomeScreenState extends State<HomeScreen> {
  List<Dependant>? _dependants;
  Set<String> _withOngoingVisit = {};
  String? _selectedId;
  String? _error;
  int _tab = 0;
  // Link requests needing the caller's attention - the bell's count.
  int _attention = 0;
  ({String id, String fullName})? _me;
  bool _isPrimaryContact = false;
  // Bumped after an edit, so every tab rebuilds and reloads (e.g. a replaced photo).
  int _version = 0;

  Dependant? get _selected =>
      _dependants?.where((d) => d.id == _selectedId).firstOrNull;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _loadRequests() async {
    try {
      final requests = await widget.linkRequestsApi.list();
      if (mounted) setState(() => _attention = requests.attentionCount);
    } catch (_) {
      // Only the bell's count - the sheet itself shows any error when opened.
    }
  }

  Future<void> _load() async {
    unawaited(_loadRequests());
    setState(() => _error = null);
    try {
      // One in_progress query covers every dependant (it's already scoped to the caller's own),
      // for the switcher's "with a caregiver now" marks.
      final results = await Future.wait<Object>([
        widget.dependantsApi.listDependants(),
        widget.visitSchedulesApi.listVisits(status: 'in_progress'),
      ]);
      if (results case [
        List<Dependant> dependants,
        List<VisitSchedule> ongoing,
      ]) {
        // Deactivated dependants go last; otherwise alphabetical.
        dependants.sort(
          (a, b) => a.active != b.active
              ? (a.active ? -1 : 1)
              : a.fullName.compareTo(b.fullName),
        );
        final wanted = _selectedId ?? await _rememberedSelection();
        if (!mounted) return;
        setState(() {
          _dependants = dependants;
          _withOngoingVisit = {for (final v in ongoing) v.dependantId};
          _selectedId = dependants.any((d) => d.id == wanted)
              ? wanted
              : dependants.firstOrNull?.id;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    }
    await _loadMe();
    await _checkPrimaryContact();
  }

  Future<String?> _rememberedSelection() async {
    try {
      return (await SharedPreferences.getInstance()).getString(_selectedDependantKey);
    } catch (_) {
      return null;
    }
  }

  // Marks the caller's own row "You" on the Family tab and personalises the greeting, so a
  // failure here just leaves those off rather than blocking anything.
  Future<void> _loadMe() async {
    if (_me != null) return;
    try {
      final me = await widget.usersApi.getMe();
      if (mounted) setState(() => _me = (id: me.id, fullName: me.fullName));
    } catch (_) {}
  }

  // Only the primary contact may edit or add the photo (the backend enforces it too), so those
  // actions show only once the caller's own link is confirmed as primary.
  Future<void> _checkPrimaryContact() async {
    final me = _me;
    final dependant = _selected;
    if (me == null || dependant == null) return;
    try {
      final members = await widget.dependantsApi.listFamilyMembers(dependant.id);
      final isPrimary = members.any((m) => m.userId == me.id && m.isPrimaryContact);
      if (mounted && _selectedId == dependant.id) {
        setState(() => _isPrimaryContact = isPrimary);
      }
    } catch (_) {}
  }

  Future<void> _select(String id) async {
    setState(() {
      _selectedId = id;
      _isPrimaryContact = false;
    });
    unawaited(_checkPrimaryContact());
    try {
      await (await SharedPreferences.getInstance()).setString(_selectedDependantKey, id);
    } catch (_) {}
  }

  Future<void> _openRequests() async {
    await showLinkRequestsSheet(
      context,
      linkRequestsApi: widget.linkRequestsApi,
      onJoinFamily: () {
        Navigator.of(context).pop();
        _joinFamily();
      },
      // An approval can add dependants to someone's list, and seen outcomes clear the count.
      onChanged: _load,
    );
    if (mounted) _load();
  }

  Future<void> _joinFamily() async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => JoinFamilyScreen(linkRequestsApi: widget.linkRequestsApi),
      ),
    );
    if (mounted) _loadRequests();
  }

  Future<void> _signOut() async {
    await widget.authService.signOut();
    widget.onSignedOut();
  }

  Future<void> _registerDependant() async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => DependantWizardScreen.register(
          dependantsApi: widget.dependantsApi,
          enrollmentsApi: widget.enrollmentsApi,
          usersApi: widget.usersApi,
          identity: widget.identity,
          onDone: () => Navigator.of(context).pop(),
        ),
      ),
    );
    if (mounted) _load();
  }

  Future<void> _edit({int initialStep = 0}) async {
    final dependant = _selected;
    if (dependant == null) return;
    final updated = await Navigator.of(context).push<Dependant>(
      MaterialPageRoute(
        builder: (_) => DependantWizardScreen.edit(
          dependantsApi: widget.dependantsApi,
          enrollmentsApi: widget.enrollmentsApi,
          existing: dependant,
          initialStep: initialStep,
        ),
      ),
    );
    if (!mounted) return;
    // A photo may have been replaced even when the details weren't saved, so reload either way.
    setState(() => _version++);
    await _load();
    if (updated != null && mounted) showSnack(context, 'Details saved.', error: false);
  }

  Future<void> _openSwitcher() async {
    final dependants = _dependants ?? const <Dependant>[];
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      backgroundColor: Colors.white,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(20, 0, 20, 8),
              child: Text(
                'Your dependants',
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600, color: inkDefault),
              ),
            ),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                children: [
                  for (final d in dependants)
                    _DependantOption(
                      dependant: d,
                      selected: d.id == _selectedId,
                      visitInProgress: _withOngoingVisit.contains(d.id),
                      onTap: () {
                        Navigator.of(sheetContext).pop();
                        _select(d.id);
                      },
                    ),
                ],
              ),
            ),
            const Divider(height: 1, color: borderColor),
            ListTile(
              minTileHeight: 56,
              leading: const Icon(Icons.add, color: primaryGreen),
              title: const Text(
                'Register a dependant',
                style: TextStyle(color: primaryGreen, fontWeight: FontWeight.w500),
              ),
              onTap: () {
                Navigator.of(sheetContext).pop();
                _registerDependant();
              },
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final dependants = _dependants;
    final selected = _selected;
    return Scaffold(
      backgroundColor: const Color(0xFFF7F7F7),
      appBar: AppBar(
        backgroundColor: Colors.white,
        surfaceTintColor: Colors.transparent,
        scrolledUnderElevation: 0,
        centerTitle: false,
        titleSpacing: 8,
        title: selected == null
            ? const Padding(
                padding: EdgeInsets.only(left: 8),
                child: Text('Mzazi Care', style: TextStyle(fontSize: 17)),
              )
            : _SwitcherButton(
                name: selected.fullName,
                canSwitch: (dependants?.length ?? 0) > 1,
                onTap: _openSwitcher,
              ),
        actions: [
          IconButton(
            tooltip: 'Family requests',
            onPressed: _openRequests,
            icon: Badge(
              isLabelVisible: _attention > 0,
              label: Text('$_attention'),
              child: const Icon(Icons.notifications_none),
            ),
          ),
          const SizedBox(width: 4),
        ],
        bottom: const PreferredSize(
          preferredSize: Size.fromHeight(1),
          child: Divider(height: 1, color: borderColor),
        ),
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        backgroundColor: Colors.white,
        indicatorColor: primaryTint,
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.wb_sunny_outlined),
            selectedIcon: Icon(Icons.wb_sunny, color: primaryGreen),
            label: 'Today',
          ),
          NavigationDestination(
            icon: Icon(Icons.event_note_outlined),
            selectedIcon: Icon(Icons.event_note, color: primaryGreen),
            label: 'Visits',
          ),
          NavigationDestination(
            icon: Icon(Icons.people_outline),
            selectedIcon: Icon(Icons.people, color: primaryGreen),
            label: 'Family',
          ),
          NavigationDestination(
            icon: Icon(Icons.person_outline),
            selectedIcon: Icon(Icons.person, color: primaryGreen),
            label: 'Account',
          ),
        ],
      ),
      body: IndexedStack(
        index: _tab,
        children: [
          for (final tab in [0, 1, 2]) _dependantTab(tab, dependants, selected),
          AccountTab(
            fullName: _me?.fullName ?? widget.identity.fullName,
            email: widget.identity.email,
            attention: _attention,
            onOpenRequests: _openRequests,
            onJoinFamily: _joinFamily,
            onRegisterDependant: _registerDependant,
            onSignOut: _signOut,
          ),
        ],
      ),
    );
  }

  /// Today, Visits or Family for the selected dependant - or, before there is one, why not.
  Widget _dependantTab(int tab, List<Dependant>? dependants, Dependant? selected) {
    if (_error case final message?) {
      return _Padded(ErrorState(message: message, onRetry: _load));
    }
    if (dependants == null) {
      return const _Padded(SkeletonCards(count: 3, cardHeight: 88));
    }
    if (selected == null) {
      return _Padded(
        EmptyState(
          icon: Icons.family_restroom,
          title: 'No dependants yet',
          message:
              'Register the person you care for, or if someone in your family already '
              'registered them, ask to be linked.',
          action: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              FilledButton(
                onPressed: _registerDependant,
                child: const Text('Register a dependant'),
              ),
              const SizedBox(height: 8),
              OutlinedButton(
                onPressed: _joinFamily,
                child: const Text('Ask to join a family'),
              ),
            ],
          ),
        ),
      );
    }
    final key = ValueKey('$tab-${selected.id}-$_version');
    return switch (tab) {
      0 => TodayTab(
        key: key,
        dependant: selected,
        myFirstName: switch (_me?.fullName ?? widget.identity.fullName) {
          final name? => firstName(name),
          null => null,
        },
        onAddPhoto: _isPrimaryContact
            ? () => _edit(initialStep: DependantWizardScreen.photoStep)
            : null,
        dependantsApi: widget.dependantsApi,
        visitSchedulesApi: widget.visitSchedulesApi,
      ),
      1 => VisitsTab(
        key: key,
        dependant: selected,
        dependantsApi: widget.dependantsApi,
        visitSchedulesApi: widget.visitSchedulesApi,
      ),
      _ => FamilyTab(
        key: key,
        dependant: selected,
        myUserId: _me?.id,
        isPrimaryContact: _isPrimaryContact,
        onEdit: _edit,
        dependantsApi: widget.dependantsApi,
      ),
    };
  }
}

class _Padded extends StatelessWidget {
  final Widget child;
  const _Padded(this.child);

  @override
  Widget build(BuildContext context) => constrainedContent(
    ListView(padding: const EdgeInsets.all(16), children: [child]),
  );
}

/// The selected dependant's name in the app bar; tapping it switches between dependants.
class _SwitcherButton extends StatelessWidget {
  final String name;
  final bool canSwitch;
  final VoidCallback onTap;

  const _SwitcherButton({required this.name, required this.canSwitch, required this.onTap});

  @override
  Widget build(BuildContext context) => InkWell(
    onTap: onTap,
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Flexible(
            child: Text(
              name,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: 17,
                fontWeight: FontWeight.w600,
                color: inkDefault,
              ),
            ),
          ),
          if (canSwitch) ...[
            const SizedBox(width: 4),
            const Icon(Icons.keyboard_arrow_down, color: inkSecondary),
          ],
        ],
      ),
    ),
  );
}

class _DependantOption extends StatelessWidget {
  final Dependant dependant;
  final bool selected;
  final bool visitInProgress;
  final VoidCallback onTap;

  const _DependantOption({
    required this.dependant,
    required this.selected,
    required this.visitInProgress,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final notes = [
      '${dependant.ageOn(DateTime.now())} years',
      if (!dependant.active) 'Deactivated',
      if (dependant.needsPhoto)
        dependant.checkinPhotoStatus == CheckinPhotoStatus.awaitingReview
            ? 'Photo awaiting review'
            : 'Photo needed',
    ].join(' · ');
    return ListTile(
      minTileHeight: 64,
      // No tinted fill: it would swallow the "In progress" chip; the filled radio marks it.
      selected: selected,
      leading: Icon(
        selected ? Icons.radio_button_checked : Icons.radio_button_unchecked,
        color: selected ? primaryGreen : inkTertiary,
      ),
      title: Text(dependant.fullName, style: const TextStyle(color: inkDefault)),
      subtitle: Text(notes, style: const TextStyle(fontSize: 12, color: inkSecondary)),
      trailing: visitInProgress ? const StatusPill('in_progress') : null,
      onTap: onTap,
    );
  }
}
