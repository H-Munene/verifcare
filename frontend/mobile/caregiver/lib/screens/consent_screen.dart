import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api/api_client.dart';
import '../api/terms_api.dart';
import '../app_ui.dart';

/// Shows [child] only once the signed-in user has accepted the current terms of use and privacy
/// notice (2026-09-26, user request). Until then the terms fill the screen and can't be dismissed:
/// no close button, and back does nothing. Accepting is recorded on the server, so it's asked
/// once per terms version. Declining closes the app, and the terms come back the next time it's
/// opened.
///
/// On iOS an app isn't allowed to close itself (Apple's guidelines treat that as a crash), so a
/// decline there leaves a screen saying the app can't be used without accepting, with a way to
/// read the terms again, instead.
class ConsentGate extends StatefulWidget {
  final TermsApi termsApi;

  /// The signed-in user's Cognito sub, so an acceptance is remembered per person.
  final String sub;
  final Widget child;

  const ConsentGate({
    super.key,
    required this.termsApi,
    required this.sub,
    required this.child,
  });

  @override
  State<ConsentGate> createState() => _ConsentGateState();
}

enum _Stage { loading, failed, asking, declined, accepted }

class _ConsentGateState extends State<ConsentGate> {
  late _Stage _stage = widget.termsApi.acceptedThisSession(widget.sub)
      ? _Stage.accepted
      : _Stage.loading;
  TermsDocument? _terms;
  String? _error;
  String? _notice;
  bool _accepting = false;

  @override
  void initState() {
    super.initState();
    if (_stage == _Stage.loading) _load();
  }

  Future<void> _load({String? notice}) async {
    setState(() {
      _stage = _Stage.loading;
      _error = null;
    });
    try {
      final terms = await widget.termsApi.current();
      if (!mounted) return;
      if (terms.accepted) widget.termsApi.rememberAccepted(widget.sub);
      setState(() {
        _terms = terms;
        _notice = notice;
        _stage = terms.accepted ? _Stage.accepted : _Stage.asking;
      });
    } catch (e) {
      if (!mounted) return;
      // Nothing to fall back to: the app stays behind the gate until the terms can be loaded.
      setState(() {
        _error = _messageFor(e);
        _stage = _Stage.failed;
      });
    }
  }

  Future<void> _accept() async {
    final terms = _terms!;
    setState(() {
      _accepting = true;
      _error = null;
    });
    try {
      await widget.termsApi.accept(sub: widget.sub, version: terms.version);
      if (mounted) setState(() => _stage = _Stage.accepted);
    } on ApiException catch (e) {
      if (e.problem.status == 409) {
        // The terms changed while they were on screen - show the new version to accept instead.
        await _load(
          notice:
              'These terms have just been updated. Please read the new version.',
        );
      } else if (mounted) {
        setState(() => _error = _messageFor(e));
      }
    } catch (e) {
      if (mounted) setState(() => _error = _messageFor(e));
    } finally {
      if (mounted) setState(() => _accepting = false);
    }
  }

  Future<void> _decline() async {
    if (defaultTargetPlatform == TargetPlatform.android) {
      // Closes the app. Nothing is recorded, so the terms are shown again on the next open.
      await SystemNavigator.pop();
    } else {
      setState(() => _stage = _Stage.declined);
    }
  }

  static String _messageFor(Object error) => switch (error) {
    ApiException(:final problem) => problem.detail ?? problem.title,
    _ => 'Could not reach the server. Check your connection and try again.',
  };

  @override
  Widget build(BuildContext context) {
    if (_stage == _Stage.accepted) return widget.child;
    return PopScope(
      canPop: false,
      child: Scaffold(
        backgroundColor: Colors.white,
        body: SafeArea(
          child: switch (_stage) {
            _Stage.loading => const Center(child: CircularProgressIndicator()),
            _Stage.failed => _Message(
              text: _error ?? 'Could not load the terms.',
              actionLabel: 'Try again',
              onAction: _load,
            ),
            _Stage.declined => _Message(
              text:
                  "Mzazi Care can't be used without accepting its terms of use and privacy "
                  'notice. You can close the app, or read the terms again.',
              actionLabel: 'Read the terms again',
              onAction: () => setState(() => _stage = _Stage.asking),
            ),
            _ => _TermsView(
              terms: _terms!,
              notice: _notice,
              error: _error,
              accepting: _accepting,
              onAccept: _accept,
              onDecline: _decline,
            ),
          },
        ),
      ),
    );
  }
}

class _TermsView extends StatelessWidget {
  final TermsDocument terms;
  final String? notice;
  final String? error;
  final bool accepting;
  final VoidCallback onAccept;
  final VoidCallback onDecline;

  const _TermsView({
    required this.terms,
    required this.notice,
    required this.error,
    required this.accepting,
    required this.onAccept,
    required this.onDecline,
  });

  @override
  Widget build(BuildContext context) {
    final effective = MaterialLocalizations.of(
      context,
    ).formatMediumDate(terms.effectiveDate);
    return Column(
      children: [
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(20, 24, 20, 16),
            children: [
              constrainedContent(
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      terms.title,
                      style: const TextStyle(
                        fontSize: 20,
                        fontWeight: FontWeight.w600,
                        color: inkDefault,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'Version ${terms.version} · effective $effective',
                      style: const TextStyle(fontSize: 12, color: inkTertiary),
                    ),
                    const SizedBox(height: 8),
                    const Text(
                      'Please read and accept to continue using Mzazi Care.',
                      style: TextStyle(fontSize: 14, color: inkSecondary),
                    ),
                    if (notice case final notice?) ...[
                      const SizedBox(height: 12),
                      _Banner(text: notice, tint: const Color(0xFFE6F1FC)),
                    ],
                    for (final section in terms.sections) ...[
                      const SizedBox(height: 20),
                      Text(
                        section.heading,
                        style: const TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                          color: inkDefault,
                        ),
                      ),
                      for (final paragraph in section.paragraphs)
                        Padding(
                          padding: const EdgeInsets.only(top: 6),
                          child: Text(
                            paragraph,
                            style: const TextStyle(
                              fontSize: 14,
                              height: 1.45,
                              color: inkSecondary,
                            ),
                          ),
                        ),
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
        Container(
          decoration: const BoxDecoration(
            color: Colors.white,
            border: Border(top: BorderSide(color: borderColor)),
          ),
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 16),
          child: constrainedContent(
            Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (error case final error?) ...[
                  _Banner(text: error, tint: dangerTint),
                  const SizedBox(height: 10),
                ],
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton(
                        onPressed: accepting ? null : onDecline,
                        style: OutlinedButton.styleFrom(
                          foregroundColor: inkDefault,
                          minimumSize: const Size.fromHeight(44),
                          side: const BorderSide(color: borderColor),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(999),
                          ),
                        ),
                        child: const Text('Decline'),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: ElevatedButton(
                        onPressed: accepting ? null : onAccept,
                        style: pillButtonStyle,
                        child: accepting
                            ? const SizedBox(
                                width: 20,
                                height: 20,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                  color: Colors.white,
                                ),
                              )
                            : const Text('Accept'),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _Banner extends StatelessWidget {
  final String text;
  final Color tint;
  const _Banner({required this.text, required this.tint});

  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: tint,
      borderRadius: BorderRadius.circular(12),
    ),
    child: Text(text, style: const TextStyle(fontSize: 13, color: inkDefault)),
  );
}

class _Message extends StatelessWidget {
  final String text;
  final String actionLabel;
  final VoidCallback onAction;

  const _Message({
    required this.text,
    required this.actionLabel,
    required this.onAction,
  });

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: constrainedContent(
        Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              text,
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 15, color: inkSecondary),
            ),
            const SizedBox(height: 16),
            ElevatedButton(
              onPressed: onAction,
              style: pillButtonStyle,
              child: Text(actionLabel),
            ),
          ],
        ),
      ),
    ),
  );
}
