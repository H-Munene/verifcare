import { AlertCircleIcon, CloudUploadIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from 'react';
import './components.css';
import './ImageDropzone.css';

// A photo picker styled after the user's inspiration (temp_images/file_upload_ui.png, 2026-09-27):
// a dashed drop zone with a round upload icon, "Drag and drop to upload or select", and the
// accepted types and size limit under it. Once a photo is chosen the zone shows a preview of it
// with Replace and Remove, so the person can see they picked the right face before saving.
//
// The real control is a native file input, visually hidden but still focusable: Tab reaches it,
// Enter or Space opens the file picker, and screen readers announce it with its label, hint and
// any error. The visible zone is a <label> for it, so a click anywhere on the zone opens the
// picker without any script.

export interface ImageDropzoneProps {
  id: string;
  /** The visible field label. */
  label: string;
  value: File | null;
  onChange: (file: File | null) => void;
  /** MIME types the zone accepts, e.g. image/jpeg. */
  accept?: readonly string[];
  maxBytes?: number;
  /** An error from outside the field, e.g. the upload failing; shown like a validation error. */
  error?: ReactNode;
  /** While uploading: the zone can't be changed and says what's happening. */
  busy?: boolean;
  busyLabel?: string;
}

const TYPE_NAMES: Record<string, string> = {
  'image/jpeg': 'JPG',
  'image/png': 'PNG',
  'image/gif': 'GIF',
  'image/webp': 'WebP',
  'image/heic': 'HEIC',
  'image/heif': 'HEIF',
};

function typeName(type: string): string {
  return TYPE_NAMES[type] ?? (type ? type.replace(/^.*\//, '').toUpperCase() : 'unknown');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
}

function listTypes(types: readonly string[]): string {
  const names = types.map(typeName);
  return names.length > 1
    ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`
    : (names[0] ?? '');
}

export function ImageDropzone({
  id,
  label,
  value,
  onChange,
  accept = ['image/jpeg', 'image/png'],
  maxBytes = 15 * 1024 * 1024,
  error,
  busy = false,
  busyLabel = 'Uploading...',
}: ImageDropzoneProps) {
  const labelId = useId();
  const hintId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // dragenter/dragleave fire for every child the pointer crosses, so count them rather than
  // trusting the last event: the highlight only clears once the pointer really leaves the zone.
  const dragDepth = useRef(0);
  // One object URL per chosen file, made when the file is chosen and revoked when it's replaced,
  // removed, or the zone goes away, so previews don't leak memory. Made in the event handler
  // rather than an effect so StrictMode's double effect run can't revoke a URL still on screen.
  const [preview, setPreview] = useState<{ file: File; url: string } | null>(null);
  const previewRef = useRef(preview);
  useEffect(() => {
    previewRef.current = preview;
  });
  useEffect(
    () => () => {
      if (previewRef.current) {
        URL.revokeObjectURL(previewRef.current.url);
      }
    },
    [],
  );
  function showPreview(file: File | null) {
    if (preview) {
      URL.revokeObjectURL(preview.url);
    }
    setPreview(file ? { file, url: URL.createObjectURL(file) } : null);
  }
  // The parent owns the value; a preview only shows while it still matches what's chosen.
  const previewUrl = value && preview?.file === value ? preview.url : null;
  const filled = Boolean(value && previewUrl);

  const hint = `${listTypes(accept)}, up to ${formatBytes(maxBytes)}`;
  const shownError = localError ?? error;

  function choose(file: File | undefined) {
    if (!file) {
      return;
    }
    if (!accept.includes(file.type)) {
      setLocalError(
        `${file.name} is a ${typeName(file.type)} file. Choose a ${listTypes(accept)} image.`,
      );
      return;
    }
    if (file.size > maxBytes) {
      setLocalError(
        `${file.name} is ${formatBytes(file.size)}. Choose an image under ${formatBytes(maxBytes)}.`,
      );
      return;
    }
    setLocalError(null);
    showPreview(file);
    onChange(file);
  }

  function remove() {
    setLocalError(null);
    showPreview(null);
    onChange(null);
    // The input itself would otherwise still hold the old file, and picking the same one again
    // wouldn't fire a change event.
    if (inputRef.current) {
      inputRef.current.value = '';
    }
    inputRef.current?.focus();
  }

  function onDragEnter(event: DragEvent) {
    event.preventDefault();
    if (busy) {
      return;
    }
    dragDepth.current += 1;
    setDragging(true);
  }

  function onDragLeave(event: DragEvent) {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) {
      setDragging(false);
    }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (!busy) {
      choose(event.dataTransfer.files[0]);
    }
  }

  const zoneClass = [
    'ds-dropzone__zone',
    filled ? 'ds-dropzone__zone--filled' : '',
    dragging ? 'ds-dropzone__zone--dragging' : '',
    shownError ? 'ds-dropzone__zone--error' : '',
    busy ? 'ds-dropzone__zone--busy' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="ds-dropzone">
      <span id={labelId} className="ds-label">
        {label}
      </span>
      <input
        ref={inputRef}
        id={id}
        type="file"
        className="ds-dropzone__input sr-only"
        accept={accept.join(',')}
        disabled={busy}
        // Once a photo is chosen, Replace and Remove are the keyboard stops instead.
        tabIndex={filled ? -1 : undefined}
        aria-labelledby={labelId}
        aria-describedby={[hintId, shownError ? errorId : ''].filter(Boolean).join(' ')}
        aria-invalid={shownError ? true : undefined}
        onChange={(event) => choose(event.target.files?.[0])}
      />
      <div
        className={zoneClass}
        onDragEnter={onDragEnter}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        aria-busy={busy || undefined}
      >
        {value && previewUrl ? (
          <div className="ds-dropzone__preview">
            <img
              className="ds-dropzone__image"
              src={previewUrl}
              alt={`Preview of ${value.name}`}
              // The type can pass the check above while the bytes aren't a readable image (a
              // renamed file, a truncated download); catching it here beats a confusing failure
              // after upload.
              onError={() => {
                setLocalError(`${value.name} couldn't be read as an image. Choose another photo.`);
                showPreview(null);
                onChange(null);
              }}
            />
            <div className="ds-dropzone__file">
              <span className="ds-dropzone__file-name">{value.name}</span>
              <span className="ds-dropzone__file-size">
                {busy ? busyLabel : formatBytes(value.size)}
              </span>
              {busy ? (
                <span className="ds-dropzone__progress" aria-hidden>
                  <span className="ds-dropzone__progress-bar" />
                </span>
              ) : (
                <span className="ds-dropzone__actions">
                  <button
                    type="button"
                    className="ds-dropzone__action"
                    onClick={() => inputRef.current?.click()}
                  >
                    Replace
                  </button>
                  <button
                    type="button"
                    className="ds-dropzone__action ds-dropzone__action--remove"
                    onClick={remove}
                  >
                    Remove
                  </button>
                </span>
              )}
            </div>
          </div>
        ) : (
          <label htmlFor={id} className="ds-dropzone__empty">
            <span className="ds-dropzone__icon" aria-hidden>
              <HugeiconsIcon icon={CloudUploadIcon} size={22} strokeWidth={1.8} />
            </span>
            <span className="ds-dropzone__prompt">
              {dragging ? (
                'Drop the photo to use it'
              ) : (
                <>
                  Drag and drop to upload or <span className="ds-dropzone__select">select</span>
                </>
              )}
            </span>
            <span id={hintId} className="ds-dropzone__hint">
              {hint}
            </span>
          </label>
        )}
        {/* The hint's id must stay in the document for aria-describedby once a file is chosen. */}
        {filled ? (
          <span id={hintId} className="sr-only">
            {hint}
          </span>
        ) : null}
      </div>
      {shownError ? (
        <div id={errorId} className="ds-dropzone__error" role="alert">
          <HugeiconsIcon icon={AlertCircleIcon} size={15} strokeWidth={1.8} aria-hidden />
          <span>{shownError}</span>
        </div>
      ) : null}
    </div>
  );
}
