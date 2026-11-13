import 'package:flutter/material.dart';

import '../../api/dependants_api.dart';
import '../../app_ui.dart';
import '../../widgets/family_link_panel.dart';
import '../../widgets/states.dart';
import '../../widgets/visit_widgets.dart';
import '../dependant_voice_screen.dart';

/// The dependant's details and everyone linked to them (2026-10-12 redesign: the old dependant
/// page's header and Family tab, together). The primary contact can edit the details and link
/// more family members.
class FamilyTab extends StatefulWidget {
  final Dependant dependant;
  final String? myUserId;
  final bool isPrimaryContact;

  /// Opens the edit wizard. Only offered to the primary contact (the backend enforces it too).
  final VoidCallback onEdit;
  final DependantsApi dependantsApi;

  const FamilyTab({
    super.key,
    required this.dependant,
    required this.myUserId,
    required this.isPrimaryContact,
    required this.onEdit,
    required this.dependantsApi,
  });

  @override
  State<FamilyTab> createState() => _FamilyTabState();
}

class _FamilyTabState extends State<FamilyTab>
    with AutomaticKeepAliveClientMixin {
  List<FamilyMemberLink>? _members;
  String? _error;
  // null until loaded; a failed lookup just leaves the voice card saying nothing yet.
  ({DateTime? at})? _voiceEnrolment;

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final members = await widget.dependantsApi.listFamilyMembers(
        widget.dependant.id,
      );
      // Primary contact first, then alphabetical.
      members.sort(
        (a, b) => a.isPrimaryContact != b.isPrimaryContact
            ? (a.isPrimaryContact ? -1 : 1)
            : a.fullName.compareTo(b.fullName),
      );
      if (mounted) setState(() => _members = members);
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    }
    try {
      final at = await widget.dependantsApi.voiceEnrolledAt(
        widget.dependant.id,
      );
      if (mounted) setState(() => _voiceEnrolment = (at: at));
    } catch (_) {}
  }

  Future<void> _recordVoice() async {
    final saved = await Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (_) => DependantVoiceScreen(
          dependant: widget.dependant,
          dependantsApi: widget.dependantsApi,
        ),
      ),
    );
    if (saved == true) _load();
  }

  Future<void> _linkMember() async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      backgroundColor: Colors.white,
      builder: (sheetContext) => Padding(
        // Lifts the form above the keyboard.
        padding: EdgeInsets.fromLTRB(
          20,
          0,
          20,
          20 + MediaQuery.viewInsetsOf(sheetContext).bottom,
        ),
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text(
                'Link a family member',
                style: TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.w600,
                  color: inkDefault,
                ),
              ),
              const SizedBox(height: 12),
              FamilyLinkPanel(
                dependantsApi: widget.dependantsApi,
                dependantId: widget.dependant.id,
                onLinked: (_) => _load(),
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final members = _members;
    return constrainedContent(
      RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
          children: [
            SectionTitle('About ${widget.dependant.fullName.split(' ').first}'),
            _AboutCard(
              dependant: widget.dependant,
              onEdit: widget.isPrimaryContact ? widget.onEdit : null,
            ),
            const SizedBox(height: 8),
            SectionTitle(
              "${widget.dependant.fullName.split(' ').first}'s voice",
            ),
            SectionCard(
              // Its own transparent Material, so the tap ripple isn't hidden by the card's colour.
              child: Material(
                type: MaterialType.transparency,
                child: ListTile(
                  leading: const Icon(
                    Icons.record_voice_over_outlined,
                    color: inkSecondary,
                  ),
                  title: Text(switch (_voiceEnrolment) {
                    null => 'Voice',
                    (at: null) => 'Not recorded yet',
                    (at: final DateTime at) =>
                      'Recorded ${MaterialLocalizations.of(context).formatMediumDate(at)}',
                  }, style: const TextStyle(fontSize: 14)),
                  subtitle: const Text(
                    'Recorded once at home, so the voice recorded at each visit can be checked.',
                    style: TextStyle(fontSize: 12, color: inkTertiary),
                  ),
                  trailing: const Icon(Icons.chevron_right, color: inkTertiary),
                  onTap: _recordVoice,
                ),
              ),
            ),
            const SizedBox(height: 8),
            const SectionTitle('Family'),
            if (_error case final message?)
              ErrorState(message: message, onRetry: _load)
            else if (members == null)
              const SkeletonCards(count: 2, cardHeight: 64)
            else
              SectionCard(
                child: Column(
                  children: [
                    for (final (i, member) in members.indexed) ...[
                      if (i > 0) const Divider(height: 1, color: borderColor),
                      _FamilyMemberTile(
                        member: member,
                        isMe: member.userId == widget.myUserId,
                      ),
                    ],
                  ],
                ),
              ),
            if (widget.isPrimaryContact)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: OutlinedButton.icon(
                  style: OutlinedButton.styleFrom(
                    minimumSize: const Size.fromHeight(48),
                  ),
                  onPressed: _linkMember,
                  icon: const Icon(Icons.person_add_alt_1_outlined),
                  label: const Text('Link a family member'),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _AboutCard extends StatelessWidget {
  final Dependant dependant;
  final VoidCallback? onEdit;

  const _AboutCard({required this.dependant, required this.onEdit});

  @override
  Widget build(BuildContext context) {
    final age = dependant.ageOn(DateTime.now());
    final facts = [
      '$age years',
      if (dependant.gender case final gender?)
        '${gender[0].toUpperCase()}${gender.substring(1)}',
      if (!dependant.active) 'Deactivated',
    ].join(' · ');
    final rows = [
      ('Home', [?dependant.homeAddressText, ?dependant.areaText].join('\n')),
      if (dependant.primaryConditionSummary case final condition?)
        ('Health', condition),
    ].where((row) => row.$2.isNotEmpty);
    return SectionCard(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      dependant.fullName,
                      style: const TextStyle(
                        fontSize: 17,
                        fontWeight: FontWeight.w600,
                        color: inkDefault,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      facts,
                      style: const TextStyle(fontSize: 13, color: inkSecondary),
                    ),
                  ],
                ),
              ),
              if (onEdit case final onEdit?)
                TextButton(onPressed: onEdit, child: const Text('Edit')),
            ],
          ),
          for (final (label, value) in rows) ...[
            const SizedBox(height: 12),
            Text(
              label,
              style: const TextStyle(fontSize: 12, color: inkTertiary),
            ),
            const SizedBox(height: 2),
            Text(
              value,
              style: const TextStyle(fontSize: 14, color: inkDefault),
            ),
          ],
        ],
      ),
    );
  }
}

String _initials(String name) => name
    .split(RegExp(r'\s+'))
    .where((part) => part.isNotEmpty)
    .take(2)
    .map((part) => part[0].toUpperCase())
    .join();

/// One linked family member, expanding to their registration details. Phone and email are
/// selectable so they can be copied to call or write to another member.
class _FamilyMemberTile extends StatelessWidget {
  final FamilyMemberLink member;
  final bool isMe;

  const _FamilyMemberTile({required this.member, required this.isMe});

  @override
  Widget build(BuildContext context) {
    final linkedAt = member.linkedAt;
    final details = [
      ('Email', member.email ?? 'Not recorded'),
      ('Phone', member.phoneNumber ?? 'Not recorded'),
      ('Relationship', member.relationship ?? 'Not set'),
      ('Added by', member.addedByName ?? 'Unknown'),
      if (linkedAt != null)
        (
          'Linked on',
          MaterialLocalizations.of(context).formatMediumDate(linkedAt),
        ),
    ];
    // Its own transparent Material, so the tap ripple isn't hidden behind the card's background.
    return Material(
      type: MaterialType.transparency,
      child: Theme(
        // ExpansionTile draws dividers above and below itself when open; the card's own dividers
        // already separate the rows.
        data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
        child: ExpansionTile(
          shape: const RoundedRectangleBorder(),
          collapsedShape: const RoundedRectangleBorder(),
          leading: Container(
            width: 40,
            height: 40,
            alignment: Alignment.center,
            color: primaryTint,
            child: Text(
              _initials(member.fullName),
              style: const TextStyle(
                fontWeight: FontWeight.w600,
                color: primaryGreen,
              ),
            ),
          ),
          title: Text(
            isMe ? '${member.fullName} (You)' : member.fullName,
            style: const TextStyle(fontSize: 14),
          ),
          // One wrapping text rather than a Row, so a long relationship plus "Primary contact"
          // wraps on a narrow phone instead of overflowing.
          subtitle: Text.rich(
            TextSpan(
              style: const TextStyle(fontSize: 12, color: inkTertiary),
              children: [
                TextSpan(text: member.relationship ?? 'Relationship not set'),
                if (member.isPrimaryContact) ...[
                  const TextSpan(text: ' · '),
                  const TextSpan(
                    text: 'Primary contact',
                    style: TextStyle(
                      fontWeight: FontWeight.w500,
                      color: primaryGreen,
                    ),
                  ),
                ],
              ],
            ),
          ),
          childrenPadding: const EdgeInsets.fromLTRB(72, 0, 16, 12),
          expandedCrossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (final (label, value) in details)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      label,
                      style: const TextStyle(fontSize: 12, color: inkTertiary),
                    ),
                    SelectableText(
                      value,
                      style: const TextStyle(fontSize: 13, color: inkDefault),
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
