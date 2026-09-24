import 'package:flutter/material.dart';

/// Full-screen, pinch-to-zoom view of one enrolled photo.
class PhotoPreviewScreen extends StatelessWidget {
  final String imageUrl;
  final String heroTag;

  const PhotoPreviewScreen({
    super.key,
    required this.imageUrl,
    required this.heroTag,
  });

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
      ),
      body: InteractiveViewer(
        minScale: 1,
        maxScale: 5,
        child: Center(
          child: Hero(
            tag: heroTag,
            child: Image.network(
              imageUrl,
              fit: BoxFit.contain,
              errorBuilder: (_, _, _) => const Text(
                'This photo link has expired - go back and pull to refresh.',
                style: TextStyle(color: Colors.white70),
                textAlign: TextAlign.center,
              ),
            ),
          ),
        ),
      ),
    );
  }
}
