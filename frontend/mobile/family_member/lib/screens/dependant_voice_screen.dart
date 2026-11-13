import 'dart:async';
import 'dart:io';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

import '../api/dependants_api.dart';
import '../app_ui.dart';

const _minDuration = Duration(seconds: 25);
const _maxDuration = Duration(seconds: 40);

enum _Mode { idle, recording, recorded }

/// Records about 30 seconds of the dependant speaking naturally, at home, which becomes the
/// voiceprint their visit recordings are checked against. Recording again replaces it. Only the
/// voiceprint is kept; the server deletes the recording. Pops true once saved.
class DependantVoiceScreen extends StatefulWidget {
  final Dependant dependant;
  final DependantsApi dependantsApi;

  const DependantVoiceScreen({
    super.key,
    required this.dependant,
    required this.dependantsApi,
  });

  @override
  State<DependantVoiceScreen> createState() => _DependantVoiceScreenState();
}

class _DependantVoiceScreenState extends State<DependantVoiceScreen> {
  final _recorder = AudioRecorder();
  final _player = AudioPlayer();
  _Mode _mode = _Mode.idle;
  File? _file;
  DateTime? _startedAt;
  Duration _elapsed = Duration.zero;
  Timer? _ticker;
  bool _saving = false;
  String? _error;

  String get _first => widget.dependant.fullName.split(' ').first;

  @override
  void dispose() {
    _ticker?.cancel();
    _recorder.dispose();
    _player.dispose();
    final file = _file;
    if (file != null && file.existsSync()) file.deleteSync();
    super.dispose();
  }

  Future<void> _start() async {
    if (!await _recorder.hasPermission()) {
      if (mounted) {
        setState(() => _error = 'Microphone access is needed to record.');
      }
      return;
    }
    final dir = await getTemporaryDirectory();
    final file = File('${dir.path}/dependant-voice.m4a');
    if (await file.exists()) await file.delete();
    await _recorder.start(
      const RecordConfig(encoder: AudioEncoder.aacLc, numChannels: 1),
      path: file.path,
    );
    _startedAt = DateTime.now();
    _ticker = Timer.periodic(const Duration(milliseconds: 200), (_) {
      setState(() => _elapsed = DateTime.now().difference(_startedAt!));
      if (_elapsed >= _maxDuration) _stop();
    });
    setState(() {
      _file = file;
      _error = null;
      _elapsed = Duration.zero;
      _mode = _Mode.recording;
    });
  }

  Future<void> _stop() async {
    if (_mode != _Mode.recording) return;
    _ticker?.cancel();
    await _recorder.stop();
    final elapsed = DateTime.now().difference(_startedAt!);
    if (elapsed < _minDuration) {
      setState(() {
        _mode = _Mode.idle;
        _error = 'Record for at least ${_minDuration.inSeconds} seconds.';
      });
      return;
    }
    setState(() => _mode = _Mode.recorded);
  }

  Future<void> _save() async {
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await widget.dependantsApi.enrolVoice(
        widget.dependant.id,
        await _file!.readAsBytes(),
      );
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final seconds = _elapsed.inSeconds;
    return Scaffold(
      backgroundColor: Colors.white,
      appBar: AppBar(
        backgroundColor: Colors.white,
        surfaceTintColor: Colors.white,
        title: Text("$_first's voice", style: const TextStyle(fontSize: 16)),
      ),
      body: constrainedContent(
        ListView(
          padding: const EdgeInsets.all(24),
          children: [
            Text(
              "In a quiet room, ask $_first to talk naturally for about 30 seconds, for example "
              'about their day or a happy memory. Hold the phone near them. Each visit, the '
              "caregiver records $_first's voice, and it is checked against this.",
              style: const TextStyle(
                fontSize: 14,
                height: 1.45,
                color: inkSecondary,
              ),
            ),
            const SizedBox(height: 32),
            Text(
              '${(seconds ~/ 60).toString().padLeft(2, '0')}:${(seconds % 60).toString().padLeft(2, '0')}',
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: 40,
                fontWeight: FontWeight.w500,
                color: _mode == _Mode.recording ? inkDefault : inkTertiary,
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            ),
            const SizedBox(height: 24),
            switch (_mode) {
              _Mode.idle => FilledButton.icon(
                onPressed: _start,
                icon: const Icon(Icons.mic),
                label: const Text('Start recording'),
              ),
              _Mode.recording => FilledButton.icon(
                onPressed: _stop,
                style: FilledButton.styleFrom(backgroundColor: dangerRed),
                icon: const Icon(Icons.stop),
                label: Text(
                  seconds < _minDuration.inSeconds
                      ? 'Keep going (${_minDuration.inSeconds - seconds} s more)'
                      : 'Stop',
                ),
              ),
              _Mode.recorded => Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  OutlinedButton.icon(
                    onPressed: () =>
                        _player.play(DeviceFileSource(_file!.path)),
                    icon: const Icon(Icons.play_arrow),
                    label: const Text('Listen back'),
                  ),
                  const SizedBox(height: 8),
                  OutlinedButton(
                    onPressed: _saving
                        ? null
                        : () => setState(() => _mode = _Mode.idle),
                    child: const Text('Record again'),
                  ),
                ],
              ),
            },
            if (_error case final message?) ...[
              const SizedBox(height: 16),
              Text(
                message,
                style: const TextStyle(fontSize: 13, color: dangerRed),
              ),
            ],
          ],
        ),
      ),
      bottomNavigationBar: SafeArea(
        child: constrainedContent(
          Padding(
            padding: const EdgeInsets.fromLTRB(24, 8, 24, 16),
            child: ElevatedButton(
              onPressed: _mode == _Mode.recorded && !_saving ? _save : null,
              style: pillButtonStyle,
              child: _saving
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: Colors.white,
                      ),
                    )
                  : Text("Save $_first's voice"),
            ),
          ),
        ),
      ),
    );
  }
}
