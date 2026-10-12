import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

import '../app_ui.dart';

const maxRecordingDuration = Duration(minutes: 5);
const _minRecordingDuration = Duration(seconds: 1);
const _barCount = 36;

/// Where a visit's audio log lives. Kept in app-private storage (other apps can't read it) and
/// keyed by visit, so the recording survives the app being closed mid-visit. Nothing uploads it
/// yet - the acoustic-model upload is later work - so it deliberately outlives checkout.
Future<File> visitAudioFile(String visitScheduleId) async {
  final dir = await getApplicationDocumentsDirectory();
  return File('${dir.path}/visit_audio/$visitScheduleId.m4a');
}

// The recorded loudness levels, so the playback waveform still draws after an app restart.
File _levelsFile(File audio) => File(audio.path.replaceFirst('.m4a', '.json'));

enum _Mode { loading, idle, recording, recorded }

/// Hold-to-record audio log with a live waveform, then playback / re-record (the user's
/// temp_images/audio1.png and audio2.png mockups). Optional for checkout (user decision
/// 2026-09-24); capped at [maxRecordingDuration].
class VisitAudioRecorder extends StatefulWidget {
  final String visitScheduleId;
  final ValueChanged<bool> onRecordingChanged;

  const VisitAudioRecorder({
    super.key,
    required this.visitScheduleId,
    required this.onRecordingChanged,
  });

  @override
  State<VisitAudioRecorder> createState() => _VisitAudioRecorderState();
}

class _VisitAudioRecorderState extends State<VisitAudioRecorder> {
  final _recorder = AudioRecorder();
  final _player = AudioPlayer();
  final _subscriptions = <StreamSubscription<Object?>>[];
  StreamSubscription<Amplitude>? _amplitudeSubscription;
  Timer? _ticker;

  _Mode _mode = _Mode.loading;
  late File _file;
  List<double> _levels = [];
  bool _pointerDown = false;
  DateTime? _startedAt;
  Duration _elapsed = Duration.zero;
  Duration _position = Duration.zero;
  Duration _duration = Duration.zero;
  bool _playing = false;

  @override
  void initState() {
    super.initState();
    _subscriptions.addAll([
      _player.onPositionChanged.listen((p) => setState(() => _position = p)),
      _player.onDurationChanged.listen((d) => setState(() => _duration = d)),
      _player.onPlayerStateChanged.listen(
        (s) => setState(() => _playing = s == PlayerState.playing),
      ),
      _player.onPlayerComplete.listen(
        (_) => setState(() => _position = _duration),
      ),
    ]);
    _load();
  }

  @override
  void dispose() {
    for (final subscription in _subscriptions) {
      subscription.cancel();
    }
    _amplitudeSubscription?.cancel();
    _ticker?.cancel();
    _recorder.dispose();
    _player.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    _file = await visitAudioFile(widget.visitScheduleId);
    if (await _file.exists()) {
      final levelsFile = _levelsFile(_file);
      if (await levelsFile.exists()) {
        _levels = (jsonDecode(await levelsFile.readAsString()) as List)
            .cast<num>()
            .map((n) => n.toDouble())
            .toList();
      }
      await _player.setSourceDeviceFile(_file.path);
      _setMode(_Mode.recorded);
    } else {
      _setMode(_Mode.idle);
    }
  }

  void _setMode(_Mode mode) {
    if (!mounted) return;
    setState(() => _mode = mode);
    widget.onRecordingChanged(mode == _Mode.recorded);
  }

  Future<void> _startRecording() async {
    _pointerDown = true;
    // The first call shows the OS permission prompt - the caregiver has let go by the time it's
    // answered, so a first-ever press only asks, it doesn't start recording.
    if (!await _recorder.hasPermission()) {
      if (mounted) showSnack(context, 'Microphone access is needed to record.');
      return;
    }
    if (!_pointerDown) return;

    await _file.parent.create(recursive: true);
    await _recorder.start(
      const RecordConfig(encoder: AudioEncoder.aacLc, numChannels: 1),
      path: _file.path,
    );
    _levels = [];
    _startedAt = DateTime.now();
    _elapsed = Duration.zero;
    _amplitudeSubscription = _recorder
        .onAmplitudeChanged(const Duration(milliseconds: 120))
        // dBFS: roughly -50 (quiet room) to 0 (clipping), mapped onto 0..1 bar heights.
        .listen((amp) => _levels.add(((amp.current + 50) / 50).clamp(0.05, 1)));
    _ticker = Timer.periodic(const Duration(milliseconds: 200), (_) {
      setState(() => _elapsed = DateTime.now().difference(_startedAt!));
      if (_elapsed >= maxRecordingDuration) _stopRecording();
    });
    _setMode(_Mode.recording);
    // Released while start() was still in flight.
    if (!_pointerDown) await _stopRecording();
  }

  Future<void> _stopRecording() async {
    _pointerDown = false;
    if (_mode != _Mode.recording) return;
    _ticker?.cancel();
    await _amplitudeSubscription?.cancel();
    _mode = _Mode.loading;
    await _recorder.stop();

    if (_elapsed < _minRecordingDuration) {
      await _deleteFiles();
      _setMode(_Mode.idle);
      if (mounted) {
        showSnack(context, 'Press and hold to record.', error: false);
      }
      return;
    }
    await _levelsFile(_file).writeAsString(jsonEncode(_levels));
    await _player.setSourceDeviceFile(_file.path);
    _position = Duration.zero;
    _setMode(_Mode.recorded);
  }

  Future<void> _deleteFiles() async {
    for (final file in [_file, _levelsFile(_file)]) {
      if (await file.exists()) await file.delete();
    }
  }

  Future<void> _rerecord() async {
    await _player.stop();
    await _deleteFiles();
    _levels = [];
    _position = Duration.zero;
    _duration = Duration.zero;
    _setMode(_Mode.idle);
  }

  Future<void> _togglePlay() async {
    if (_playing) {
      await _player.pause();
      return;
    }
    if (_duration > Duration.zero && _position >= _duration) {
      await _player.seek(Duration.zero);
    }
    await _player.resume();
  }

  Future<void> _skip(int seconds) async {
    final target = _position + Duration(seconds: seconds);
    await _player.seek(
      target < Duration.zero
          ? Duration.zero
          : (target > _duration ? _duration : target),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(20, 20, 20, 16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: borderColor),
      ),
      child: switch (_mode) {
        _Mode.loading => const SizedBox(
          height: 120,
          child: Center(child: CircularProgressIndicator()),
        ),
        _Mode.recorded => _buildPlayback(),
        _ => _buildRecorder(),
      },
    );
  }

  // Idle and recording share one layout so the hold button stays the same widget between the
  // two - swapping it out mid-press would lose the pointer-up that stops the recording.
  Widget _buildRecorder() {
    final recording = _mode == _Mode.recording;
    return Column(
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            if (recording) ...[
              Container(
                width: 8,
                height: 8,
                decoration: const BoxDecoration(
                  color: dangerRed,
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: 8),
            ],
            Text(
              recording ? 'RECORDING AMBIENT AUDIO' : 'AUDIO LOG',
              style: const TextStyle(
                fontSize: 12,
                letterSpacing: 0.6,
                color: inkTertiary,
              ),
            ),
          ],
        ),
        const SizedBox(height: 8),
        Text(
          _format(_elapsed),
          style: TextStyle(
            fontSize: 36,
            fontWeight: FontWeight.w500,
            color: recording ? inkDefault : inkTertiary,
            fontFeatures: const [FontFeature.tabularFigures()],
          ),
        ),
        const SizedBox(height: 12),
        _Waveform(
          levels: _levels.length > _barCount
              ? _levels.sublist(_levels.length - _barCount)
              : _levels,
          activeColor: primaryBlue,
        ),
        const SizedBox(height: 12),
        Text(
          recording
              ? 'Recording will auto-stop at 5 minutes.'
              : 'Optional. Press and hold to record - up to 5 minutes.',
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: 12, color: inkTertiary),
        ),
        const SizedBox(height: 16),
        Listener(
          onPointerDown: (_) => _startRecording(),
          onPointerUp: (_) => _stopRecording(),
          onPointerCancel: (_) => _stopRecording(),
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 150),
            width: recording ? 80 : 72,
            height: recording ? 80 : 72,
            decoration: const BoxDecoration(
              color: dangerRed,
              shape: BoxShape.circle,
            ),
            child: Center(
              child: recording
                  ? Container(
                      width: 24,
                      height: 24,
                      decoration: BoxDecoration(
                        color: Colors.white,
                        borderRadius: BorderRadius.circular(6),
                      ),
                    )
                  : const Icon(Icons.mic, color: Colors.white, size: 30),
            ),
          ),
        ),
        const SizedBox(height: 8),
        Text(
          recording ? 'Release to stop' : 'Hold to record',
          style: const TextStyle(fontSize: 12, color: inkSecondary),
        ),
      ],
    );
  }

  Widget _buildPlayback() {
    final progress = _duration.inMilliseconds == 0
        ? 0.0
        : _position.inMilliseconds / _duration.inMilliseconds;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text(
          'AUDIO LOG',
          textAlign: TextAlign.center,
          style: TextStyle(
            fontSize: 12,
            letterSpacing: 0.6,
            color: inkTertiary,
          ),
        ),
        const SizedBox(height: 16),
        _Waveform(
          levels: _resample(_levels),
          activeColor: inkDefault,
          activeFraction: progress,
        ),
        const SizedBox(height: 8),
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(_format(_position), style: _timeStyle),
            Text(_format(_duration), style: _timeStyle),
          ],
        ),
        const SizedBox(height: 16),
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            TextButton(
              onPressed: () => _skip(-10),
              style: TextButton.styleFrom(foregroundColor: inkSecondary),
              child: const Text('-10s', style: TextStyle(fontSize: 16)),
            ),
            const SizedBox(width: 20),
            Material(
              color: primaryBlue,
              shape: const CircleBorder(),
              child: InkWell(
                customBorder: const CircleBorder(),
                onTap: _togglePlay,
                child: SizedBox(
                  width: 56,
                  height: 56,
                  child: Icon(
                    _playing ? Icons.pause : Icons.play_arrow,
                    color: Colors.white,
                    size: 30,
                  ),
                ),
              ),
            ),
            const SizedBox(width: 20),
            TextButton(
              onPressed: () => _skip(10),
              style: TextButton.styleFrom(foregroundColor: inkSecondary),
              child: const Text('+10s', style: TextStyle(fontSize: 16)),
            ),
          ],
        ),
        const SizedBox(height: 16),
        OutlinedButton(
          onPressed: _rerecord,
          style: OutlinedButton.styleFrom(
            foregroundColor: inkDefault,
            minimumSize: const Size.fromHeight(44),
            side: const BorderSide(color: borderColor),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(10),
            ),
          ),
          child: const Text('Re-record'),
        ),
      ],
    );
  }

  static const _timeStyle = TextStyle(fontSize: 12, color: inkTertiary);

  static String _format(Duration d) =>
      '${d.inMinutes.toString().padLeft(2, '0')}:${(d.inSeconds % 60).toString().padLeft(2, '0')}';

  // Squeezes the whole recording's levels into [_barCount] bars (peak of each slice).
  static List<double> _resample(List<double> levels) {
    if (levels.isEmpty) return List.filled(_barCount, 0.3);
    return List.generate(_barCount, (i) {
      final start = i * levels.length ~/ _barCount;
      final end = max(start + 1, (i + 1) * levels.length ~/ _barCount);
      return levels.sublist(start, min(end, levels.length)).reduce(max);
    });
  }
}

/// Fixed-width row of [_barCount] bars. Bars past the end of [levels] (or past
/// [activeFraction]) draw in the idle grey, like the mockups' unfilled tail.
class _Waveform extends StatelessWidget {
  final List<double> levels;
  final Color activeColor;
  final double? activeFraction;

  const _Waveform({
    required this.levels,
    required this.activeColor,
    this.activeFraction,
  });

  @override
  Widget build(BuildContext context) {
    // Each bar gets an equal slot of the available width (bar 4/7 of it, gap 3/7, capped at the
    // mockup's 4px bar), so narrow phones shrink the bars rather than overflow the card.
    return LayoutBuilder(
      builder: (context, constraints) {
        final slot = min(7.0, constraints.maxWidth / _barCount);
        return SizedBox(
          height: 44,
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: List.generate(_barCount, (i) {
              final hasLevel = i < levels.length;
              final active =
                  hasLevel &&
                  (activeFraction == null || i < activeFraction! * _barCount);
              return Container(
                width: slot * 4 / 7,
                height: 6 + (hasLevel ? levels[i] : 0.25) * 34,
                margin: EdgeInsets.symmetric(horizontal: slot * 1.5 / 7),
                decoration: BoxDecoration(
                  color: active ? activeColor : waveformIdle,
                  borderRadius: BorderRadius.circular(2),
                ),
              );
            }),
          ),
        );
      },
    );
  }
}
