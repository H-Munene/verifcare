import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import type { Dependant, DependantGender, DependantStatus } from '../api/dependants';
import { useApi } from '../api/useApi';
import { useAuth } from '../auth/AuthContext';
import { ExactLocationMap } from '../components/ExactLocationMap';
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
// nothing extra). The primaryFamilyMember mini-form only appears when registering - later family
// members are added from the Dependant Detail page (DependantDetailPage.tsx, HEZ-56), matching
// architecture.md's "first family member is linked atomically at registration, later members
// added separately" design.
//
// Presented as a stepper (2026-09-14, user request - modeled on a standard e-commerce checkout
// stepper) rather than one long scrolling form: Details -> Location -> Exact Location -> Primary
// Contact (registration only; editing has no primary-contact step, since that's not part of
// PATCH /dependants/{id} at all - it's managed from DependantDetailPage instead). Location and
// Exact Location are two separate steps, not two sections of one step (confirmed with the user) -
// the county/constituency/ward cascade and the bounded Google Maps pin are different enough
// concerns to warrant their own steps, and combining them into one page was also part of what
// caused the Leaflet map's rendering to break (see components/LocationSelectorMap.tsx's own fix).
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
  const { dependants } = useApi();
  const { identity } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const steps = isEdit
    ? ['Details', 'Location', 'Exact Location']
    : ['Details', 'Location', 'Exact Location', 'Primary Contact', 'Additional Contacts'];
  const [step, setStep] = useState(0);
  const isLastStep = step === steps.length - 1;

  const initialName = splitFullName(initial?.fullName ?? '');
  const [firstName, setFirstName] = useState(initialName.firstName);
  const [lastName, setLastName] = useState(initialName.lastName);
  const [dob, setDob] = useState(initial?.dob ?? '');
  const [gender, setGender] = useState<DependantGender | ''>(initial?.gender ?? '');
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
  const [exactLocationValid, setExactLocationValid] = useState(false);

  function handleExactLocationChange(lat: number, lng: number, isInsideWard: boolean): void {
    setGeofenceLat(lat);
    setGeofenceLng(lng);
    setExactLocationValid(isInsideWard);
  }

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

  // Per-step validity, gating the "Next step" button the same way the final Save button was
  // already gated - a step's own required fields must be filled before moving on, rather than
  // discovering a validation problem only after reaching the end.
  const detailsValid = firstName.trim() !== '' && lastName.trim() !== '' && dob !== '';
  // A brand-new registration must resolve county/constituency/ward and place a valid pin before it
  // can proceed (confirmed with the user) - editing an existing dependant is not blocked on either,
  // since the backend only requires them at creation, not on every update.
  const locationSelectorValid = county !== '' && constituency !== '' && ward !== '';
  const exactLocationStepValid =
    geofenceLat !== null &&
    geofenceLng !== null &&
    exactLocationValid &&
    geofenceRadiusMeters !== '';
  const primaryContactValid = Boolean(primarySelection);
  // Additional Contacts (step 4) is deliberately not included here - the user confirmed it's
  // optional and skippable with no validation, so the `?? true` fallback below covers it.
  const currentStepValid =
    [
      detailsValid,
      isEdit || locationSelectorValid,
      isEdit || exactLocationStepValid,
      primaryContactValid,
    ][step] ?? true;
  // Surfaces *why* Next/Save is disabled, rather than leaving a disabled button as the only signal
  // - the underlying gate above is what actually enforces this; this is purely to make it visible.
  const stepHints = [
    'Enter first name, last name, and date of birth to continue.',
    'Select a county, constituency, and ward to continue.',
    'Place a pin inside the ward boundary to continue.',
    'Select a primary family member to continue.',
  ];
  const currentStepHint = currentStepValid ? null : stepHints[step];

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!isLastStep) {
      // Defensive only - the submit button doesn't exist in the DOM before the last step, so this
      // shouldn't normally fire, but an Enter keypress in some browsers can still submit a form
      // with no visible submit button.
      return;
    }
    void submitForm();
  }

  async function submitForm() {
    const common = {
      fullName: `${firstName} ${lastName}`.trim(),
      dob,
      gender: gender || undefined,
      primaryConditionSummary: primaryConditionSummary || undefined,
      geofenceRadiusMeters: Number(geofenceRadiusMeters),
      cognitiveMonitoringEnabled: effectiveCognitiveMonitoringEnabled,
    };

    if (isEdit) {
      try {
        await updateMutation.mutateAsync({
          ...common,
          // Sent only when the supervisor actually re-resolved these on this edit (e.g. by
          // picking a new ward and pin) - an unrelated field edit must not overwrite existing
          // county/constituency/ward/coordinates, and the backend's own zod schema rejects an
          // empty county/constituency/ward string outright.
          ...(county ? { county } : {}),
          ...(constituency ? { constituency } : {}),
          ...(ward ? { ward } : {}),
          ...(geofenceLat !== null ? { geofenceLat } : {}),
          ...(geofenceLng !== null ? { geofenceLng } : {}),
          ...(identity?.role === 'supervisor' ? { status } : {}),
        });
        void queryClient.invalidateQueries({ queryKey: ['dependants'] });
        void queryClient.invalidateQueries({ queryKey: ['dependant', dependantId] });
        void navigate(`/dependants/${dependantId}`);
      } catch {
        // updateMutation's own `error` state (surfaced via mutationError below) already reports
        // this - nothing further to do here.
      }
      return;
    }

    if (!primarySelection) {
      return;
    }

    try {
      const created = await createMutation.mutateAsync({
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
      });

      // Each additional contact is its own linking call, made only now that a dependantId
      // exists - POST /dependants can only ever link one (the primary) family member atomically.
      // A failure here must not undo the registration that already succeeded; it's surfaced as a
      // separate, non-blocking notice instead, since the contact can still be added afterward
      // from the dependant's own detail page.
      setAdditionalContactError(null);
      for (const contact of additionalContacts) {
        if (!contact.selection) {
          continue;
        }
        try {
          await dependants.addFamilyMember(created.id, {
            ...contact.selection,
            relationship: contact.relationship || undefined,
          });
        } catch {
          setAdditionalContactError(
            "The dependant was registered, but one or more additional family contacts could not be added. Add them from the dependant's detail page instead.",
          );
        }
      }

      void queryClient.invalidateQueries({ queryKey: ['dependants'] });
      void navigate(`/dependants/${created.id}`);
    } catch {
      // createMutation's own `error` state (surfaced via mutationError below) already reports
      // this - nothing further to do here.
    }
  }

  const pending = createMutation.isPending || updateMutation.isPending;
  const mutationError = createMutation.error ?? updateMutation.error;

  return (
    <div className="register-dependant-page">
      <h1 className="register-dependant-page__title">
        {isEdit ? 'Edit Dependant' : 'Register Dependant'}
      </h1>
      <Stepper steps={steps} currentStepIndex={step} />
      <form onSubmit={handleSubmit} className="register-dependant-page__form" autoComplete="off">
        {step === 0 ? (
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

        {step === 1 ? (
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

        {step === 2 ? (
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

        {step === 3 && !isEdit ? (
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

        {step === 4 && !isEdit ? (
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
          {isLastStep ? (
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
