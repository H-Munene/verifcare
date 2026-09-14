import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import type { Dependant, DependantGender, DependantStatus } from '../api/dependants';
import { useApi } from '../api/useApi';
import { useAuth } from '../auth/AuthContext';
import {
  FamilyMemberResolver,
  type FamilyMemberSelection,
} from '../components/FamilyMemberResolver';
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
// stepper) rather than one long scrolling form: Details -> Geofence -> Primary Contact
// (registration only; editing has no primary-contact step, since that's not part of
// PATCH /dependants/{id} at all - it's managed from DependantDetailPage instead).
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

function DependantForm({ dependantId, initial }: { dependantId?: string; initial?: Dependant }) {
  const isEdit = Boolean(dependantId);
  const { dependants } = useApi();
  const { identity } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const steps = isEdit ? ['Details', 'Geofence'] : ['Details', 'Geofence', 'Primary Contact'];
  const [step, setStep] = useState(0);
  const isLastStep = step === steps.length - 1;

  const [fullName, setFullName] = useState(initial?.fullName ?? '');
  const [dob, setDob] = useState(initial?.dob ?? '');
  const [gender, setGender] = useState<DependantGender | ''>(initial?.gender ?? '');
  const [homeAddressText, setHomeAddressText] = useState(initial?.homeAddressText ?? '');
  const [geofenceLat, setGeofenceLat] = useState(initial ? String(initial.geofenceLat) : '');
  const [geofenceLng, setGeofenceLng] = useState(initial ? String(initial.geofenceLng) : '');
  // 20m default - confirmed with the user 2026-09-14 (originally proposed at 10m, revised up after
  // flagging that typical smartphone GPS accuracy, ~5m under open sky and substantially worse
  // indoors/urban, leaves too thin a margin at 10m against a genuinely-present caregiver). See
  // docs/project-state.md and architecture.md's "geofence accuracy threshold" open item.
  const [geofenceRadiusMeters, setGeofenceRadiusMeters] = useState(
    initial ? String(initial.geofenceRadiusMeters) : '20',
  );
  const [cognitiveMonitoringEnabled, setCognitiveMonitoringEnabled] = useState(
    initial?.cognitiveMonitoringEnabled ?? false,
  );
  const [status, setStatus] = useState<DependantStatus>(initial?.status ?? 'active');

  const [primarySelection, setPrimarySelection] = useState<FamilyMemberSelection | null>(null);
  const [primaryRelationship, setPrimaryRelationship] = useState('');

  const createMutation = useMutation({
    mutationFn: dependants.createDependant,
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ['dependants'] });
      void navigate(`/dependants/${created.id}`);
    },
  });
  const updateMutation = useMutation({
    mutationFn: (body: Parameters<typeof dependants.updateDependant>[1]) =>
      dependants.updateDependant(dependantId!, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['dependants'] });
      void queryClient.invalidateQueries({ queryKey: ['dependant', dependantId] });
      void navigate(`/dependants/${dependantId}`);
    },
  });

  // Per-step validity, gating the "Next step" button the same way the final Save button was
  // already gated - a step's own required fields must be filled before moving on, rather than
  // discovering a validation problem only after reaching the end.
  const detailsValid = fullName.trim() !== '' && dob !== '';
  const geofenceValid = geofenceLat !== '' && geofenceLng !== '' && geofenceRadiusMeters !== '';
  const primaryContactValid = Boolean(primarySelection);
  const currentStepValid = [detailsValid, geofenceValid, primaryContactValid][step] ?? true;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!isLastStep) {
      // Defensive only - the submit button doesn't exist in the DOM before the last step, so this
      // shouldn't normally fire, but an Enter keypress in some browsers can still submit a form
      // with no visible submit button.
      return;
    }

    const common = {
      fullName,
      dob,
      gender: gender || undefined,
      homeAddressText: homeAddressText || undefined,
      geofenceLat: Number(geofenceLat),
      geofenceLng: Number(geofenceLng),
      geofenceRadiusMeters: Number(geofenceRadiusMeters),
      cognitiveMonitoringEnabled,
    };

    if (isEdit) {
      updateMutation.mutate({
        ...common,
        ...(identity?.role === 'supervisor' ? { status } : {}),
      });
    } else if (primarySelection) {
      createMutation.mutate({
        ...common,
        primaryFamilyMember: {
          ...primarySelection,
          relationship: primaryRelationship || undefined,
        },
      });
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
            <Input
              id="fullName"
              label="Dependant Full name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              required
            />
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
            <Input
              id="homeAddressText"
              label="Home address"
              value={homeAddressText}
              onChange={(e) => setHomeAddressText(e.target.value)}
            />
          </Card>
        ) : null}

        {step === 1 ? (
          <Card className="register-dependant-page__section">
            <div className="register-dependant-page__geofence">
              {/* Placeholder for the embedded Google Maps pin-drag picker - no platform-restricted
                  API key has been created yet (see docs/project-state.md). Lat/lng/radius are
                  still fully editable as plain number inputs. */}
              <div className="register-dependant-page__map-placeholder">Map (placeholder)</div>
              <div className="register-dependant-page__geofence-fields">
                <Input
                  id="geofenceLat"
                  label="Geofence latitude"
                  type="number"
                  step="any"
                  value={geofenceLat}
                  onChange={(e) => setGeofenceLat(e.target.value)}
                  required
                />
                <Input
                  id="geofenceLng"
                  label="Geofence longitude"
                  type="number"
                  step="any"
                  value={geofenceLng}
                  onChange={(e) => setGeofenceLng(e.target.value)}
                  required
                />
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
            <Switch
              checked={cognitiveMonitoringEnabled}
              onChange={setCognitiveMonitoringEnabled}
              label="Enable cognitive monitoring"
            />
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
          </Card>
        ) : null}

        {step === 2 && !isEdit ? (
          <Card className="register-dependant-page__section">
            <div className="register-dependant-page__section-title">Primary family member</div>
            <FamilyMemberResolver selection={primarySelection} onSelect={setPrimarySelection} />
            <Input
              id="primaryRelationship"
              label="Relationship"
              value={primaryRelationship}
              onChange={(e) => setPrimaryRelationship(e.target.value)}
            />
          </Card>
        ) : null}

        {mutationError ? (
          <div className="register-dependant-page__error">
            {mutationError instanceof ApiError
              ? (mutationError.problem.detail ?? mutationError.problem.title)
              : 'Something went wrong.'}
          </div>
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
