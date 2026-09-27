import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { BiometricEnrollment } from '../api/biometricEnrollments';
import { uploadFileToPresignedUrl } from '../api/biometricEnrollments';
import { ApiError } from '../api/client';
import type { Dependant, DependantGender, DependantStatus } from '../api/dependants';
import { useApi } from '../api/useApi';
import { useAuth } from '../auth/AuthContext';
import { ExactLocationMap } from '../components/ExactLocationMap';
import { isPointInFeature } from '../geo/adminBoundaries';
import {
  FamilyMemberResolver,
  type FamilyMemberSelection,
} from '../components/FamilyMemberResolver';
import { LocationSelector, type ResolvedWard } from '../components/LocationSelector';
import { Button } from '../design-system/Button';
import { Card } from '../design-system/Card';
import { Input } from '../design-system/Input';
import { Stepper } from '../design-system/Stepper';
import { Switch } from '../design-system/Switch';
import './RegisterDependantPage.css';

// Handles both registration (no :dependantId in the route) and editing (wireframe page 5 combines
// both into one form, and PATCH /dependants/{id} already existed from HEZ-30, so this costs
// nothing extra).
//
// Presented as a stepper (2026-09-14, user request - modeled on a standard e-commerce checkout
// stepper) rather than one long scrolling form: Details -> Location -> Exact Location -> [Primary
// Contact, Additional Contacts - registration only] -> Photo. Primary Contact is registration-only
// since it's a one-time choice made atomically at `POST /dependants` (HEZ-30's own
// "primaryFamilyMember" field), never revisited on an edit. Additional Contacts was briefly added
// to editing too (2026-09-21), then reverted the same day: DependantDetailPage's own "+ Add Family
// Member" is already the edit-time entry point for the identical addFamilyMember call, and having
// two separate UI paths to it was confirmed as unwanted, not an oversight worth fixing. Photo is the
// one step editing keeps alongside registration - enrolling/replacing a check-in photo is just as
// meaningful for an already-registered dependant as for a brand-new one. Location and Exact Location
// are two separate steps, not two sections of one step (confirmed with the user) - the
// county/constituency/ward cascade and the bounded Google Maps pin are different enough concerns to
// warrant their own steps, and combining them into one page was also part of what caused the Leaflet
// map's rendering to break (see components/LocationSelectorMap.tsx's own fix).
//
// Photo is a trailing step, not folded into Details - POST /biometric-enrollments requires the
// dependant to already exist (it looks the subject up by id before allowing an enrollment), which
// registration doesn't have until the step before Photo's own "Save" creates it. "Save" on that step
// (Additional Contacts for registration, Exact Location for editing) therefore creates/updates the
// dependant and advances into the Photo step instead of navigating away; the Photo step's own
// Skip/Finish actions do the navigation. Why this dependant photo needs to exist at all: check-in's
// dependant co-presence step (HEZ-35) CompareFaces-matches the live check-in photo against this
// subject's own active enrollment, and fails with not_enrolled if there isn't one. Confirmed with
// the user as a single required photo (matches the caregiver check-in step's own single-photo
// design), not the full 1-3 image slots DependantDetailPage's Biometric Enrollment section supports
// - that page remains where a skipped photo (or a 2nd/3rd image) gets added later, imageOrder fixed
// at 1 here rather than exposed as a choice. Editing shows whatever's already enrolled at imageOrder
// 1 (if any) before the upload form, so this step doesn't look like "no photo exists" when one does.
//
// Consent capture (biometric-verification / audio-cognitive-monitoring, shown in the wireframe)
// is deliberately not built here - HEZ-40 ("Consent capture endpoints") is a separate, not-yet-
// built backend issue with no field on CreateDependantRequest for it at all.
//
// This outer component only decides *when* to render the form - DependantForm below is not
// rendered until the existing dependant (in edit mode) has actually loaded, so its field state can
// be initialized directly from real data via plain useState, with no effect needed to sync fetched
// data into local state after the fact (the react-hooks/set-state-in-effect anti-pattern).
export function RegisterDependantPage() {
  const { dependantId } = useParams<{ dependantId: string }>();
  const isEdit = Boolean(dependantId);
  const { dependants } = useApi();

  const existing = useQuery({
    queryKey: ['dependant', dependantId],
    queryFn: () => dependants.getDependant(dependantId!),
    enabled: isEdit,
  });

  if (isEdit && existing.isLoading) {
    return <p>Loading...</p>;
  }
  if (isEdit && (existing.isError || !existing.data)) {
    return <p>Failed to load this dependant.</p>;
  }

  return <DependantForm dependantId={dependantId} initial={existing.data} />;
}

// Whole years, not a rough day-count division - matches how "age" is normally understood (a
// person turns N on their birthday, not 365.25*N days after birth).
function calculateAge(dobText: string): number | null {
  if (!dobText) {
    return null;
  }
  const dob = new Date(dobText);
  if (Number.isNaN(dob.getTime())) {
    return null;
  }
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const beforeBirthdayThisYear =
    today.getMonth() < dob.getMonth() ||
    (today.getMonth() === dob.getMonth() && today.getDate() < dob.getDate());
  if (beforeBirthdayThisYear) {
    age -= 1;
  }
  return age;
}

// The backend only ever stores one fullName string - splitting it into two display fields is a
// pure UI convenience (confirmed as the scope of the request, not a data-model change), so editing
// an existing dependant needs to re-derive first/last from that one string. Ambiguous for anyone
// with more than two name parts, same as any first/last split would be - the first space is the
// boundary, matching how the fields are laid out (First Name, then everything else as Last Name).
function splitFullName(fullName: string): { firstName: string; lastName: string } {
  const trimmed = fullName.trim();
  const spaceIndex = trimmed.indexOf(' ');
  if (spaceIndex === -1) {
    return { firstName: trimmed, lastName: '' };
  }
  return { firstName: trimmed.slice(0, spaceIndex), lastName: trimmed.slice(spaceIndex + 1) };
}

interface AdditionalContactDraft {
  selection: FamilyMemberSelection | null;
  relationship: string;
}

function DependantForm({ dependantId, initial }: { dependantId?: string; initial?: Dependant }) {
  const isEdit = Boolean(dependantId);
  const { dependants, biometricEnrollments } = useApi();
  const { identity } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // Additional Contacts is registration-only (2026-09-21 revision, reverted the same day it was
  // added to editing) - DependantDetailPage's own "+ Add Family Member" is already the edit-time
  // entry point for this, and having two separate UI paths to the same addFamilyMember call was
  // confirmed as unwanted, not an oversight to fix. Primary Contact remains registration-only too,
  // for the original reason (a one-time choice made atomically at `POST /dependants`). Photo is the
  // one step editing keeps alongside registration - enrolling/replacing a check-in photo is just as
  // meaningful for an already-registered dependant.
  const steps = isEdit
    ? ['Details', 'Location', 'Exact Location', 'Photo']
    : ['Details', 'Location', 'Exact Location', 'Primary Contact', 'Additional Contacts', 'Photo'];
  const [step, setStep] = useState(0);
  // Named positions, not magic numbers - registration and editing use different step orders.
  const detailsStepIndex = 0;
  const locationStepIndex = 1;
  const exactLocationStepIndex = 2;
  const primaryContactStepIndex = isEdit ? -1 : 3;
  const additionalContactsStepIndex = isEdit ? -1 : 4;
  // Always the last step in both orderings.
  const photoStepIndex = steps.length - 1;
  // The step that actually creates the dependant and submits via the form - Additional Contacts
  // for registration (Photo, after it, is a trailing step with its own Skip/Finish actions, not
  // part of this "Save" gate). Editing never submits through a wizard step at all any more: the
  // dependant already exists, so every edit-mode transition is a plain "Next step"/"Back" (below),
  // and persisting changes happens via the title bar's own Save button (saveEdit below) instead -
  // this was a real, reported bug, not just a preference: the old design switched this same footer
  // slot from a type="button" "Next step" to a type="submit" "Save" the instant Exact Location
  // became current, and a real click's mouseup could land on the just-swapped-in Save button
  // (confirmed via a trusted, submitter="Save" submit event firing right after a single "Next
  // step" click), silently PATCHing the dependant and skipping straight into the Photo step.
  const isDataEntryLastStep = !isEdit && step === additionalContactsStepIndex;
  const isPhotoStep = step === photoStepIndex;

  const initialName = splitFullName(initial?.fullName ?? '');
  const [firstName, setFirstName] = useState(initialName.firstName);
  const [lastName, setLastName] = useState(initialName.lastName);
  const [dob, setDob] = useState(initial?.dob ?? '');
  const [gender, setGender] = useState<DependantGender | ''>(initial?.gender ?? '');
  const [homeAddressText, setHomeAddressText] = useState(initial?.homeAddressText ?? '');
  const [primaryConditionSummary, setPrimaryConditionSummary] = useState(
    initial?.primaryConditionSummary ?? '',
  );

  // Cognitive monitoring can only be enabled for a dependant over 65 (confirmed with the user) -
  // lives in the Details step, alongside dob, since dob is what gates it. Derived at render time,
  // not synced via an effect + setState: a dob edited down to 65-or-under during this same session
  // must not leave a stale `true` behind, and computing the *effective* value here (rather than
  // forcing the underlying state itself to false) means the Switch and the submit payload can
  // never disagree, with no risk of an effect running one render late.
  const age = calculateAge(dob);
  const cognitiveMonitoringAllowed = age !== null && age > 65;
  const [cognitiveMonitoringEnabled, setCognitiveMonitoringEnabled] = useState(
    initial?.cognitiveMonitoringEnabled ?? false,
  );
  const effectiveCognitiveMonitoringEnabled =
    cognitiveMonitoringAllowed && cognitiveMonitoringEnabled;

  // HEZ-86 (revised): county/constituency/ward are now chosen explicitly via cascading dropdowns
  // (components/LocationSelector.tsx) against OpenStreetMap boundary data, forward - not resolved
  // by reverse-geocoding a dropped pin. The ward's own geometry is kept alongside the plain name,
  // since components/ExactLocationMap.tsx (a separate step) needs it to bound the Google Maps view
  // and validate the pin actually falls inside it.
  const [county, setCounty] = useState(initial?.county ?? '');
  const [constituency, setConstituency] = useState(initial?.constituency ?? '');
  const [ward, setWard] = useState(initial?.ward ?? '');
  const [wardFeature, setWardFeature] = useState<ResolvedWard['wardFeature'] | null>(null);

  function handleWardResolved(resolved: ResolvedWard | null): void {
    if (!resolved) {
      setCounty('');
      setConstituency('');
      setWard('');
      setWardFeature(null);
      return;
    }
    setCounty(resolved.countyName);
    setConstituency(resolved.constituencyName);
    setWard(resolved.wardName);
    setWardFeature(resolved.wardFeature);
  }

  // The exact pin (Google Maps, bounded to the selected ward, its own step) - lat/lng inputs were
  // removed for UX reasons (confirmed with the user); the pin is the only way to set them now.
  const [geofenceLat, setGeofenceLat] = useState<number | null>(initial?.geofenceLat ?? null);
  const [geofenceLng, setGeofenceLng] = useState<number | null>(initial?.geofenceLng ?? null);

  function handleExactLocationChange(lat: number, lng: number): void {
    setGeofenceLat(lat);
    setGeofenceLng(lng);
  }

  // Whether the pin is inside the selected ward, worked out from the pin and the ward's boundary on
  // every render rather than remembered from the last tap (2026-09-26, user report: Next and Save
  // must be disabled while the pin is outside the ward). Deriving it also catches a ward changed
  // after the pin was placed, and an edit's saved pin, which the old tap-time flag missed. null
  // when there's nothing to check yet (no pin, or the ward's boundary isn't loaded).
  const pinInsideWard =
    wardFeature && geofenceLat !== null && geofenceLng !== null
      ? isPointInFeature(geofenceLat, geofenceLng, wardFeature)
      : null;

  // 20m default - confirmed with the user 2026-09-14 (originally proposed at 10m, revised up after
  // flagging that typical smartphone GPS accuracy, ~5m under open sky and substantially worse
  // indoors/urban, leaves too thin a margin at 10m against a genuinely-present caregiver). See
  // docs/project-state.md and architecture.md's "geofence accuracy threshold" open item.
  const [geofenceRadiusMeters, setGeofenceRadiusMeters] = useState(
    initial ? String(initial.geofenceRadiusMeters) : '20',
  );
  const [status, setStatus] = useState<DependantStatus>(initial?.status ?? 'active');

  const [primarySelection, setPrimarySelection] = useState<FamilyMemberSelection | null>(null);
  const [primaryRelationship, setPrimaryRelationship] = useState('');

  // Additional family contacts (2026-09-21, HEZ-86 revision) - optional, unlike the primary
  // contact above: POST /dependants only ever links one family member atomically, so each of
  // these is sent as its own POST /dependants/{id}/family-members call after the dependant itself
  // is created (see submitForm below), not folded into the create request.
  const [additionalContacts, setAdditionalContacts] = useState<AdditionalContactDraft[]>([]);
  const [additionalContactError, setAdditionalContactError] = useState<string | null>(null);

  // Set once the dependant is actually created (see submitForm below), which is what unlocks the
  // Photo step - biometric-enrollments' own FK check requires this id to already exist. Editing
  // starts with it already set to the real id - the dependant obviously already exists, so the
  // Photo step needs no prior "create/save" action to unlock it, unlike registration.
  const [createdDependantId, setCreatedDependantId] = useState<string | null>(dependantId ?? null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoResult, setPhotoResult] = useState<BiometricEnrollment | null>(null);

  function addAdditionalContact() {
    setAdditionalContacts((prev) => [...prev, { selection: null, relationship: '' }]);
  }
  function updateAdditionalContactSelection(
    index: number,
    selection: FamilyMemberSelection | null,
  ) {
    setAdditionalContacts((prev) => prev.map((c, i) => (i === index ? { ...c, selection } : c)));
  }
  function updateAdditionalContactRelationship(index: number, relationship: string) {
    setAdditionalContacts((prev) => prev.map((c, i) => (i === index ? { ...c, relationship } : c)));
  }

  // Neither mutation navigates from its own onSuccess (unlike most other forms in this app) -
  // registration must first fire off each additional family contact's own POST (see submitForm
  // below), and navigating before those settle would abandon them mid-flight if the page unmounts.
  const createMutation = useMutation({ mutationFn: dependants.createDependant });
  const updateMutation = useMutation({
    mutationFn: (body: Parameters<typeof dependants.updateDependant>[1]) =>
      dependants.updateDependant(dependantId!, body),
  });

  // Single required photo, imageOrder fixed at 1 - see the file header comment for why this exists
  // and why it's just one image here, unlike DependantDetailPage's full 1-3 slot picker.
  const photoMutation = useMutation({
    mutationFn: async () => {
      if (!photoFile || !createdDependantId) {
        throw new Error('Choose a photo first.');
      }
      if (!['image/jpeg', 'image/png'].includes(photoFile.type)) {
        throw new Error('Only JPEG or PNG images are accepted.');
      }
      const contentType = photoFile.type as 'image/jpeg' | 'image/png';
      const presigned = await biometricEnrollments.createUploadUrl({
        subjectType: 'dependant',
        subjectId: createdDependantId,
        imageOrder: 1,
        contentType,
      });
      await uploadFileToPresignedUrl(presigned.uploadUrl, photoFile);
      return biometricEnrollments.confirmEnrollment({
        subjectType: 'dependant',
        subjectId: createdDependantId,
        s3Key: presigned.s3Key,
        imageOrder: 1,
      });
    },
    onSuccess: (enrollment) => setPhotoResult(enrollment),
  });

  // Editing reaches the Photo step with a dependant that may already have an enrolled photo - shown
  // above the upload form so this step doesn't look like "no photo exists" when one does (a fresh
  // registration has nothing to find yet, but the query is harmless either way).
  const existingEnrollmentQuery = useQuery({
    queryKey: ['dependant', createdDependantId, 'biometric-enrollments', 'photo-step'],
    queryFn: () => biometricEnrollments.listEnrollments('dependant', createdDependantId!),
    enabled: isPhotoStep && Boolean(createdDependantId),
  });
  const existingEnrollment = existingEnrollmentQuery.data?.find((e) => e.imageOrder === 1);

  // Per-step validity, gating the "Next step" button the same way the final Save button was
  // already gated - a step's own required fields must be filled before moving on, rather than
  // discovering a validation problem only after reaching the end. Additional Contacts and Photo are
  // deliberately not included in either array - both are optional/skippable with no validation, so
  // the `?? true` fallback below covers them regardless of mode.
  const detailsValid = firstName.trim() !== '' && lastName.trim() !== '' && dob !== '';
  // A brand-new registration must resolve county/constituency/ward and place a valid pin before it
  // can proceed (confirmed with the user) - editing an existing dependant is not blocked on either,
  // since the backend only requires them at creation, not on every update.
  const locationSelectorValid = county !== '' && constituency !== '' && ward !== '';
  const exactLocationStepValid = pinInsideWard === true && geofenceRadiusMeters !== '';
  const primaryContactValid = Boolean(primarySelection);
  // Editing isn't blocked on location in general (see above), but never on a pin known to be
  // outside the ward.
  const editPinValid = pinInsideWard !== false;
  const stepValidityByIndex = isEdit
    ? [detailsValid, true, editPinValid]
    : [detailsValid, locationSelectorValid, exactLocationStepValid, primaryContactValid];
  const currentStepValid = stepValidityByIndex[step] ?? true;
  // Surfaces *why* Next/Save is disabled, rather than leaving a disabled button as the only signal
  // - the underlying gate above is what actually enforces this; this is purely to make it visible.
  const stepHints = isEdit
    ? [
        'Enter first name, last name, and date of birth to continue.',
        null,
        'Move the pin inside the ward boundary to continue.',
      ]
    : [
        'Enter first name, last name, and date of birth to continue.',
        'Select a county, constituency, and ward to continue.',
        'Place a pin inside the ward boundary to continue.',
        'Select a primary family member to continue.',
      ];
  const currentStepHint = currentStepValid ? null : stepHints[step];

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!isDataEntryLastStep) {
      // Defensive only - preventEnterSubmit below already stops the real-world case (Enter inside
      // a text input), this only guards a submit reaching here some other way.
      return;
    }
    void submitForm();
  }

  // Pressing Enter inside a plain text input implicitly submits its form when a submit button
  // exists anywhere in it - the Additional Contacts step's own Save button qualifies, so without
  // this, pressing Enter while typing a new family member's name/email/etc. immediately fired
  // Save and jumped to the Photo step mid-entry (a real bug found by testing, not a guess).
  // Buttons are deliberately not excluded here - Enter on a focused button should still activate
  // it normally, and its target.tagName is "BUTTON", not "INPUT".
  function preventEnterSubmit(event: KeyboardEvent<HTMLFormElement>): void {
    if (event.key === 'Enter' && (event.target as HTMLElement).tagName === 'INPUT') {
      event.preventDefault();
    }
  }

  // Each additional contact is its own linking call (POST /dependants only ever links the primary
  // contact atomically) - a failure here must not undo the save that already succeeded, so it's
  // surfaced as a separate, non-blocking notice instead, since the contact can still be added
  // afterward from the dependant's own detail page. Submitted drafts are cleared afterward (success
  // or failure) so that going Back to this step and saving again - now possible since the Photo
  // step has its own Back button too - never resends the same contact a second time.
  async function linkAdditionalContacts(id: string) {
    const drafts = additionalContacts.filter((c) => c.selection);
    if (drafts.length === 0) {
      return;
    }
    setAdditionalContactError(null);
    for (const contact of drafts) {
      try {
        await dependants.addFamilyMember(id, {
          ...contact.selection!,
          relationship: contact.relationship || undefined,
        });
      } catch {
        setAdditionalContactError(
          "The dependant was saved, but one or more additional family contacts could not be added. Add them from the dependant's detail page instead.",
        );
      }
    }
    setAdditionalContacts([]);
  }

  // Edit mode's own save action (title bar's Save button, per the user's explicit request to save
  // from wherever they are in the wizard, not just at the end) - completely independent of `step`,
  // unlike submitForm below: it never advances or reads isDataEntryLastStep, so there is no footer
  // step-transition button left in edit mode that also submits (see isDataEntryLastStep's own
  // comment for the real bug that caused).
  async function saveEdit() {
    try {
      await updateMutation.mutateAsync({
        fullName: `${firstName} ${lastName}`.trim(),
        gender: gender || undefined,
        homeAddressText: homeAddressText || undefined,
        primaryConditionSummary: primaryConditionSummary || undefined,
        geofenceRadiusMeters: Number(geofenceRadiusMeters),
        cognitiveMonitoringEnabled: effectiveCognitiveMonitoringEnabled,
        // Sent only when the supervisor actually re-resolved these on this edit (e.g. by picking a
        // new ward and pin) - an unrelated field edit must not overwrite existing
        // county/constituency/ward/coordinates, and the backend's own zod schema rejects an empty
        // county/constituency/ward string outright.
        ...(county ? { county } : {}),
        ...(constituency ? { constituency } : {}),
        ...(ward ? { ward } : {}),
        ...(geofenceLat !== null ? { geofenceLat } : {}),
        ...(geofenceLng !== null ? { geofenceLng } : {}),
        ...(identity?.role === 'supervisor' ? { status } : {}),
      });
      void queryClient.invalidateQueries({ queryKey: ['dependants'] });
      void queryClient.invalidateQueries({ queryKey: ['dependant', dependantId] });
      // Back to the dependant's page once saved (2026-09-26, user report: Save used to leave the
      // supervisor on the edit form with no sign it had worked).
      void navigate(`/dependants/${dependantId}`);
    } catch {
      // updateMutation's own `error` state (surfaced via mutationError below) already reports this
      // - nothing further to do here.
    }
  }

  // Registration only from here on - editing never reaches this (isDataEntryLastStep is always
  // false for isEdit, so handleSubmit's own guard above never calls this in edit mode).
  async function submitForm() {
    const common = {
      fullName: `${firstName} ${lastName}`.trim(),
      dob,
      gender: gender || undefined,
      homeAddressText: homeAddressText || undefined,
      primaryConditionSummary: primaryConditionSummary || undefined,
      geofenceRadiusMeters: Number(geofenceRadiusMeters),
      cognitiveMonitoringEnabled: effectiveCognitiveMonitoringEnabled,
    };

    if (!primarySelection) {
      return;
    }

    try {
      // Only actually create once - revisiting this step (via the Photo step's own Back button)
      // after createdDependantId is already set must not POST a second, duplicate dependant.
      const id =
        createdDependantId ??
        (
          await createMutation.mutateAsync({
            ...common,
            county,
            constituency,
            ward,
            geofenceLat: geofenceLat!,
            geofenceLng: geofenceLng!,
            primaryFamilyMember: {
              ...primarySelection,
              relationship: primaryRelationship || undefined,
            },
          })
        ).id;

      await linkAdditionalContacts(id);
      void queryClient.invalidateQueries({ queryKey: ['dependants'] });
      // Don't navigate yet - advance into the Photo step instead, now that a real dependantId
      // exists for it to enroll a photo against.
      setCreatedDependantId(id);
      setStep((s) => s + 1);
    } catch {
      // createMutation's own `error` state (surfaced via mutationError below) already reports
      // this - nothing further to do here.
    }
  }

  const pending = createMutation.isPending || updateMutation.isPending;
  const mutationError = createMutation.error ?? updateMutation.error;

  return (
    <div className="register-dependant-page">
      <div className="register-dependant-page__title-row">
        <h1 className="register-dependant-page__title">
          {isEdit ? 'Edit Dependant' : 'Register Dependant'}
        </h1>
        {isEdit ? (
          <Button
            type="button"
            variant="primary"
            disabled={updateMutation.isPending || !detailsValid || !editPinValid}
            title={editPinValid ? undefined : 'Move the pin inside the ward boundary to save.'}
            onClick={() => void saveEdit()}
          >
            {updateMutation.isPending ? 'Saving...' : 'Save'}
          </Button>
        ) : null}
      </div>
      <Stepper steps={steps} currentStepIndex={step} />
      {isEdit && !editPinValid && step !== exactLocationStepIndex ? (
        <p className="register-dependant-page__step-hint">
          The pin is outside the selected ward - move it inside the boundary on the Exact Location
          step to save.
        </p>
      ) : null}
      <form
        onSubmit={handleSubmit}
        onKeyDown={preventEnterSubmit}
        className="register-dependant-page__form"
        autoComplete="off"
      >
        {step === detailsStepIndex ? (
          <Card className="register-dependant-page__section">
            <div className="register-dependant-page__name-row">
              <Input
                id="firstName"
                label="First name"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                required
              />
              <Input
                id="lastName"
                label="Last name"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                required
              />
            </div>
            <Input
              id="dob"
              label="Dependant Date of birth"
              type="date"
              value={dob}
              onChange={(e) => setDob(e.target.value)}
              required
            />
            <div className="register-dependant-page__field">
              <label className="ds-label" htmlFor="gender">
                Gender
              </label>
              <select
                id="gender"
                className="ds-input"
                value={gender}
                onChange={(e) => setGender(e.target.value as DependantGender | '')}
              >
                <option value="">Not specified</option>
                <option value="male">Male</option>
                <option value="female">Female</option>
              </select>
            </div>
            <div className="register-dependant-page__field">
              <label className="ds-label" htmlFor="homeAddressText">
                Home address details
              </label>
              <textarea
                id="homeAddressText"
                className="ds-input register-dependant-page__textarea"
                rows={2}
                placeholder='Apartment/unit number, floor, building name, or other detail a caregiver would need to actually find the door (e.g. "Apt 4B, 3rd floor, Blue Gate Apartments") - the map pin below covers the general location, this covers the last few steps'
                value={homeAddressText}
                onChange={(e) => setHomeAddressText(e.target.value)}
              />
            </div>
            <div className="register-dependant-page__field">
              <label className="ds-label" htmlFor="primaryConditionSummary">
                Primary condition summary
              </label>
              <textarea
                id="primaryConditionSummary"
                className="ds-input register-dependant-page__textarea"
                rows={3}
                placeholder="General description of the dependant's condition (e.g. early-stage dementia, mobility aid required)"
                value={primaryConditionSummary}
                onChange={(e) => setPrimaryConditionSummary(e.target.value)}
              />
            </div>
            <Switch
              checked={effectiveCognitiveMonitoringEnabled}
              onChange={setCognitiveMonitoringEnabled}
              label="Enable cognitive monitoring"
              disabled={!cognitiveMonitoringAllowed}
              hint={
                cognitiveMonitoringAllowed
                  ? undefined
                  : 'Available only for dependants over the age of 65.'
              }
            />
          </Card>
        ) : null}

        {step === locationStepIndex ? (
          <div className="register-dependant-page__section">
            {/* LocationSelector owns the cascading dropdown UI state itself, but unmounts and
                remounts fresh every time the wizard leaves and returns to this step (this ternary
                returns null while step !== 1) - passing this page's own already-resolved
                county/constituency/ward (falling back to the edited dependant's existing values)
                as the hydration seed makes it re-select the same cascade on remount, instead of
                coming back visually empty even though a selection was already made this session. */}
            <LocationSelector
              initialCountyName={county || initial?.county}
              initialConstituencyName={constituency || initial?.constituency}
              initialWardName={ward || initial?.ward}
              onWardResolved={handleWardResolved}
            />
          </div>
        ) : null}

        {step === exactLocationStepIndex ? (
          <div className="register-dependant-page__section">
            {wardFeature ? (
              <ExactLocationMap
                apiKey={import.meta.env.VITE_GOOGLE_MAPS_API_KEY}
                wardFeature={wardFeature}
                lat={geofenceLat}
                lng={geofenceLng}
                radiusMeters={Number(geofenceRadiusMeters) || 0}
                onPositionChange={handleExactLocationChange}
              />
            ) : (
              <p className="register-dependant-page__resolution-hint">
                Go back and select a county, constituency, and ward before pinning the exact
                location.
              </p>
            )}

            <div className="register-dependant-page__geofence">
              <div className="register-dependant-page__geofence-fields">
                <Input
                  id="geofenceRadiusMeters"
                  label="Geofence radius (meters)"
                  type="number"
                  min={1}
                  value={geofenceRadiusMeters}
                  onChange={(e) => setGeofenceRadiusMeters(e.target.value)}
                  required
                />
              </div>
            </div>

            {isEdit && identity?.role === 'supervisor' ? (
              <div className="register-dependant-page__field">
                <label className="ds-label" htmlFor="status">
                  Status
                </label>
                <select
                  id="status"
                  className="ds-input"
                  value={status}
                  onChange={(e) => setStatus(e.target.value as DependantStatus)}
                >
                  <option value="active">Active</option>
                  <option value="deactivated">Deactivated</option>
                </select>
              </div>
            ) : null}
          </div>
        ) : null}

        {!isEdit && step === primaryContactStepIndex ? (
          <Card className="register-dependant-page__section">
            <div className="register-dependant-page__section-title">Primary family member</div>
            <FamilyMemberResolver selection={primarySelection} onSelect={setPrimarySelection} />
            <Input
              id="primaryRelationship"
              label="Relationship with Dependant"
              value={primaryRelationship}
              onChange={(e) => setPrimaryRelationship(e.target.value)}
            />
          </Card>
        ) : null}

        {step === additionalContactsStepIndex ? (
          <div className="register-dependant-page__section">
            <p className="register-dependant-page__resolution-hint">
              Optional - add any other family members who should have access to this dependant. You
              can skip this step and add them later from the dependant&rsquo;s detail page.
            </p>
            {additionalContacts.map((contact, index) => (
              <Card key={index} className="register-dependant-page__section">
                <div className="register-dependant-page__section-title">
                  Family contact {index + 2}
                </div>
                <FamilyMemberResolver
                  selection={contact.selection}
                  onSelect={(selection) => updateAdditionalContactSelection(index, selection)}
                />
                <Input
                  id={`additionalContactRelationship-${index}`}
                  label="Relationship with Dependant"
                  value={contact.relationship}
                  onChange={(e) => updateAdditionalContactRelationship(index, e.target.value)}
                />
              </Card>
            ))}
            <Button type="button" onClick={addAdditionalContact}>
              Add another family contact
            </Button>
          </div>
        ) : null}

        {isPhotoStep && createdDependantId ? (
          <Card className="register-dependant-page__section">
            <div className="register-dependant-page__section-title">Dependant&rsquo;s photo</div>
            <p className="register-dependant-page__resolution-hint">
              This lets check-in recognize {firstName || 'the dependant'} when a caregiver checks in
              for a visit. Optional for now - you can add or replace it later from the
              dependant&rsquo;s detail page instead.
            </p>
            {photoResult ? (
              <>
                <p>
                  {photoResult.status === 'flagged'
                    ? `This photo matched an already-enrolled ${photoResult.matchedSubjectType} at ${photoResult.matchedSimilarity?.toFixed(1)}% similarity - it's been flagged for a supervisor to review on the Reviews page, and hasn't been activated.`
                    : `Uploaded and activated - quality score ${photoResult.qualityScore?.toFixed(1) ?? 'n/a'}.`}
                </p>
                <div className="register-dependant-page__step-actions">
                  <Button
                    type="button"
                    variant="primary"
                    onClick={() => void navigate(`/dependants/${createdDependantId}`)}
                  >
                    Finish
                  </Button>
                </div>
              </>
            ) : (
              <>
                {existingEnrollment ? (
                  <p className="register-dependant-page__resolution-hint">
                    {existingEnrollment.status === 'flagged'
                      ? 'The current photo is flagged for a supervisor to review on the Reviews page.'
                      : `Already enrolled - quality score ${existingEnrollment.qualityScore?.toFixed(1) ?? 'n/a'}. Uploading a new photo replaces it.`}
                  </p>
                ) : null}
                <Input
                  id="dependantPhoto"
                  type="file"
                  label="Photo (JPEG or PNG)"
                  accept="image/jpeg,image/png"
                  onChange={(e) => setPhotoFile(e.target.files?.[0] ?? null)}
                />
                {photoMutation.error ? (
                  <div className="register-dependant-page__error">
                    {photoMutation.error instanceof Error
                      ? photoMutation.error.message
                      : 'Something went wrong.'}
                  </div>
                ) : null}
                <div className="register-dependant-page__step-actions">
                  <Button
                    type="button"
                    onClick={() => void navigate(`/dependants/${createdDependantId}`)}
                  >
                    {existingEnrollment ? 'Keep current photo' : 'Skip for now'}
                  </Button>
                  <Button
                    type="button"
                    variant="primary"
                    disabled={photoMutation.isPending || !photoFile}
                    onClick={() => photoMutation.mutate()}
                  >
                    {photoMutation.isPending
                      ? 'Uploading...'
                      : existingEnrollment
                        ? 'Replace & Finish'
                        : 'Upload & Finish'}
                  </Button>
                </div>
              </>
            )}
          </Card>
        ) : null}

        {mutationError ? (
          <div className="register-dependant-page__error">
            {mutationError instanceof ApiError
              ? (mutationError.problem.detail ?? mutationError.problem.title)
              : 'Something went wrong.'}
          </div>
        ) : null}

        {additionalContactError ? (
          <div className="register-dependant-page__error">{additionalContactError}</div>
        ) : null}

        {currentStepHint ? (
          <p className="register-dependant-page__step-hint">{currentStepHint}</p>
        ) : null}

        <div className="register-dependant-page__step-actions">
          {step > 0 ? (
            <Button type="button" onClick={() => setStep((s) => s - 1)}>
              Back
            </Button>
          ) : null}
          {isPhotoStep ? null : isDataEntryLastStep ? (
            <Button type="submit" variant="primary" disabled={pending || !currentStepValid}>
              {pending ? 'Saving...' : 'Save'}
            </Button>
          ) : (
            <Button
              type="button"
              variant="primary"
              disabled={!currentStepValid}
              onClick={() => setStep((s) => s + 1)}
            >
              Next step
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
