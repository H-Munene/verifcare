import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

import '../api/visit_schedules_api.dart';
import '../app_ui.dart';

const maxRecordingDuration = Duration(seconds: 30);
// The visit recording is checked against a voiceprint, which needs at least 10 seconds of speaking
// (the server enforces it too).
const visitRecordingMinDuration = Duration(seconds: 10);
const _barCount = 36;

/// The on-phone key of a visit's recording of the dependant, made at check-out (only the dependant
/// is recorded since 2026-11-24).
String visitRecordingKey(String visitScheduleId) =>
    '$visitScheduleId-dependant';

/// Where a recording lives. Kept in app-private storage (other apps can't read it) and keyed, so
/// it survives the app being closed mid-visit. A visit's recordings stay here until it's checked
/// out, so a failed upload or a refused check-out can simply be retried.
Future<File> recordingFile(String key) async {
  final dir = await getApplicationDocumentsDirectory();
  return File('${dir.path}/visit_audio/$key.m4a');
}

// The recorded loudness levels, so the playback waveform still draws after an app restart.
File _levelsFile(File audio) => File(audio.path.replaceFirst('.m4a', '.json'));

// The recording's length, which the upload has to state and the file doesn't readily give up.
File _secondsFile(File audio) =>
    File(audio.path.replaceFirst('.m4a', '.seconds'));

/// A saved recording's bytes and length, or null when there isn't one.
Future<({List<int> bytes, int seconds})?> readRecording(String key) async {
  final file = await recordingFile(key);
  if (!await file.exists()) return null;
  final seconds = _secondsFile(file);
  return (
    bytes: await file.readAsBytes(),
    seconds: await seconds.exists()
        ? int.parse(await seconds.readAsString())
        : maxRecordingDuration.inSeconds,
  );
}

/// Uploads the visit's recording of the dependant saved on this phone and returns its voice check,
/// or null when there's no recording.
Future<VoiceCheck?> uploadVisitAudio(
  VisitSchedulesApi api,
  String visitScheduleId,
) async {
  final recording = await readRecording(visitRecordingKey(visitScheduleId));
  if (recording == null) return null;
  return api.uploadDependantAudio(
    visitScheduleId,
    bytes: recording.bytes,
    durationSeconds: recording.seconds,
  );
}

/// Removes a recording from this phone, once it is no longer needed here.
Future<void> deleteRecording(String key) async {
  final file = await recordingFile(key);
  for (final path in [file, _levelsFile(file), _secondsFile(file)]) {
    if (await path.exists()) await path.delete();
  }
}

/// Removes a visit's recordings from this phone, including a caregiver recording left by an app
/// version from before 2026-11-24.
Future<void> deleteVisitAudio(String visitScheduleId) async {
  await deleteRecording(visitRecordingKey(visitScheduleId));
  await deleteRecording('$visitScheduleId-caregiver');
}

enum _Mode { loading, idle, recording, recorded }

/// Hold-to-record with a live waveform, then playback / re-record (the user's
/// temp_images/audio1.png and audio2.png mockups), between [minDuration] and [maxDuration]. Used
/// for the dependant's voice at check-out, under its own [storageKey].
class VisitAudioRecorder extends StatefulWidget {
  final String storageKey;
  final String label;
  final String hint;
  final Duration minDuration;
  final Duration maxDuration;

  /// Tap to start and tap to stop, instead of holding: for recordings too long to hold a finger
  /// down for.
  final bool tapToRecord;
  final ValueChanged<bool> onRecordingChanged;

  const VisitAudioRecorder({
    super.key,
    required this.storageKey,
    required this.label,
    required this.hint,
    required this.onRecordingChanged,
    this.minDuration = visitRecordingMinDuration,
    this.maxDuration = maxRecordingDuration,
    this.tapToRecord = false,
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
    _file = await recordingFile(widget.storageKey);
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
      // Reset, or tap mode would ignore every later tap as a start still in flight.
      _pointerDown = false;
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
      if (_elapsed >= widget.maxDuration) _stopRecording();
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
    _elapsed = DateTime.now().difference(_startedAt!);

    if (_elapsed < widget.minDuration) {
      await _deleteFiles();
      _setMode(_Mode.idle);
      if (mounted) {
        showSnack(
          context,
          'Hold for at least ${widget.minDuration.inSeconds} seconds.',
          error: false,
        );
      }
      return;
    }
    await _levelsFile(_file).writeAsString(jsonEncode(_levels));
    await _secondsFile(_file).writeAsString(
      min(_elapsed.inSeconds, widget.maxDuration.inSeconds).toString(),
    );
    await _player.setSourceDeviceFile(_file.path);
    _position = Duration.zero;
    _setMode(_Mode.recorded);
  }

  Future<void> _deleteFiles() async {
    for (final file in [_file, _levelsFile(_file), _secondsFile(_file)]) {
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
        borderRadius: BorderRadius.zero,
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
                  shape: BoxShape.rectangle,
                ),
              ),
              const SizedBox(width: 8),
            ],
            Text(
              recording ? 'RECORDING' : widget.label.toUpperCase(),
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
          activeColor: primaryGreen,
        ),
        const SizedBox(height: 12),
        Text(
          recording
              ? 'Recording stops by itself at ${widget.maxDuration.inSeconds} seconds.'
              : widget.hint,
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: 12, color: inkTertiary),
        ),
        const SizedBox(height: 16),
        Listener(
          // In tap mode a tap while a start is still in flight is ignored, so it can't start twice.
          onPointerDown: (_) => widget.tapToRecord
              ? (recording
                    ? _stopRecording()
                    : (_pointerDown ? null : _startRecording()))
              : _startRecording(),
          onPointerUp: (_) => widget.tapToRecord ? null : _stopRecording(),
          onPointerCancel: (_) => widget.tapToRecord ? null : _stopRecording(),
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 150),
            width: recording ? 80 : 72,
            height: recording ? 80 : 72,
            decoration: const BoxDecoration(
              color: dangerRed,
              shape: BoxShape.rectangle,
            ),
            child: Center(
              child: recording
                  ? Container(
                      width: 24,
                      height: 24,
                      decoration: BoxDecoration(
                        color: Colors.white,
                        borderRadius: BorderRadius.zero,
                      ),
                    )
                  : const Icon(Icons.mic, color: Colors.white, size: 30),
            ),
          ),
        ),
        const SizedBox(height: 8),
        Text(
          widget.tapToRecord
              ? (recording ? 'Tap to stop' : 'Tap to record')
              : (recording ? 'Release to stop' : 'Hold to record'),
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
        Text(
          widget.label.toUpperCase(),
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
              color: primaryGreen,
              shape: const RoundedRectangleBorder(),
              child: InkWell(
                customBorder: const RoundedRectangleBorder(),
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
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.zero),
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
                  borderRadius: BorderRadius.zero,
                ),
              );
            }),
          ),
        );
      },
    );
  }
}
