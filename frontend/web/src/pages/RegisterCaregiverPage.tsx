import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type KeyboardEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type {
  Caregiver,
  CaregiverGender,
  CaregiverIdType,
  CaregiverOccupation,
} from '../api/caregivers';
import { useApi } from '../api/useApi';
import { useAuth } from '../auth/AuthContext';
import { ExactLocationMap } from '../components/ExactLocationMap';
import { LocationSelector, type ResolvedWard } from '../components/LocationSelector';
import { getConfig } from '../config';
import { isPointInFeature } from '../geo/adminBoundaries';
import { Button } from '../design-system/Button';
import { Card } from '../design-system/Card';
import { Input } from '../design-system/Input';
import { DetailSkeleton } from '../design-system/Skeleton';
import { Stepper } from '../design-system/Stepper';
import { PHONE_HINT, toE164, toLocalPhone } from '../phone';
import './RegisterCaregiverPage.css';
import { LoadError } from '../design-system/LoadError';

// Waits for the caregiver being edited to load, so CaregiverForm can start its fields from it.
export function RegisterCaregiverPage() {
  const { caregiverId } = useParams<{ caregiverId: string }>();
  const isEdit = Boolean(caregiverId);
  const { caregivers } = useApi();
  const { identity } = useAuth();

  // Every /caregivers route is supervisor-only; this covers someone opening the URL directly.
  const isSupervisor = identity?.role === 'supervisor';

  const existing = useQuery({
    queryKey: ['caregiver', caregiverId],
    queryFn: () => caregivers.getCaregiver(caregiverId!),
    enabled: isEdit && isSupervisor,
  });

  if (!isSupervisor) {
    return <p>Only supervisors can register or edit caregivers.</p>;
  }
  if (isEdit && existing.isLoading) {
    return <DetailSkeleton />;
  }
  if (isEdit && !existing.data) {
    return <LoadError what="this caregiver" onRetry={() => void existing.refetch()} />;
  }

  return <CaregiverForm caregiverId={caregiverId} initial={existing.data} />;
}

// Same split as RegisterDependantPage: the backend stores one fullName.
function splitFullName(fullName: string): { firstName: string; lastName: string } {
  const trimmed = fullName.trim();
  const spaceIndex = trimmed.indexOf(' ');
  if (spaceIndex === -1) {
    return { firstName: trimmed, lastName: '' };
  }
  return { firstName: trimmed.slice(0, spaceIndex), lastName: trimmed.slice(spaceIndex + 1) };
}

// The same three steps as a dependant's registration: Details, Location, Exact Location. The home
// base (the last two) is optional, but a caregiver without one is left out of day plans.
const STEPS = ['Details', 'Location', 'Exact Location'];
const DETAILS_STEP = 0;
const LOCATION_STEP = 1;
const EXACT_LOCATION_STEP = 2;

function CaregiverForm({ caregiverId, initial }: { caregiverId?: string; initial?: Caregiver }) {
  const isEdit = Boolean(caregiverId);
  const { caregivers } = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [step, setStep] = useState(DETAILS_STEP);

  const initialName = splitFullName(initial?.fullName ?? '');
  const [firstName, setFirstName] = useState(initialName.firstName);
  const [lastName, setLastName] = useState(initialName.lastName);
  const [email, setEmail] = useState(initial?.email ?? '');
  // Typed as 07.../01..., sent as +254... (Cognito only accepts E.164).
  const [phone, setPhone] = useState(initial?.phoneNumber ? toLocalPhone(initial.phoneNumber) : '');
  const [idType, setIdType] = useState<CaregiverIdType | ''>(initial?.idType ?? '');
  const [idNumber, setIdNumber] = useState(initial?.idNumber ?? '');
  const [dob, setDob] = useState(initial?.dob ?? '');
  const [gender, setGender] = useState<CaregiverGender | ''>(initial?.gender ?? '');
  const [occupation, setOccupation] = useState<CaregiverOccupation | ''>(initial?.occupation ?? '');
  const phoneNumber = toE164(phone);

  const [area, setArea] = useState<ResolvedWard | null>(null);
  const [baseLat, setBaseLat] = useState<number | null>(null);
  const [baseLng, setBaseLng] = useState<number | null>(null);

  // The selector re-reports the same ward when its step is shown again, so the pin is only
  // cleared when the ward actually changes.
  function handleAreaResolved(resolved: ResolvedWard | null): void {
    const sameWard =
      resolved !== null &&
      area !== null &&
      resolved.countyName === area.countyName &&
      resolved.constituencyName === area.constituencyName &&
      resolved.wardName === area.wardName;
    setArea(resolved);
    if (!sameWard) {
      setBaseLat(null);
      setBaseLng(null);
    }
  }

  const basePinValid =
    baseLat === null || baseLng === null || !area
      ? true
      : isPointInFeature(baseLat, baseLng, area.wardFeature);
  const homeBase =
    area && baseLat !== null && baseLng !== null
      ? { baseLat, baseLng, baseAreaText: `${area.wardName}, ${area.countyName}` }
      : {};

  const createMutation = useMutation({ mutationFn: caregivers.createCaregiver });
  const updateMutation = useMutation({
    mutationFn: (body: Parameters<typeof caregivers.updateCaregiver>[1]) =>
      caregivers.updateCaregiver(caregiverId!, body),
  });
  const pending = createMutation.isPending || updateMutation.isPending;

  const detailsValid =
    firstName.trim() !== '' &&
    lastName.trim() !== '' &&
    email.trim() !== '' &&
    phoneNumber !== null &&
    idType !== '' &&
    idNumber.trim() !== '' &&
    dob !== '' &&
    gender !== '' &&
    occupation !== '';
  const canSave = detailsValid && basePinValid;
  const stepValid = [detailsValid, true, basePinValid][step];
  const stepHint = stepValid
    ? null
    : [
        'Fill in every field, with a Kenyan mobile number, to continue.',
        null,
        'Move the pin inside the selected ward to save.',
      ][step];

  async function save() {
    if (!canSave || phoneNumber === null) {
      return;
    }
    const body = {
      fullName: `${firstName.trim()} ${lastName.trim()}`,
      email: email.trim(),
      phoneNumber,
      idType,
      idNumber: idNumber.trim(),
      dob,
      gender,
      occupation,
      ...homeBase,
    };
    try {
      let savedId = caregiverId;
      if (isEdit) {
        await updateMutation.mutateAsync(body);
        void queryClient.invalidateQueries({ queryKey: ['caregiver', caregiverId] });
      } else {
        savedId = (await createMutation.mutateAsync(body)).userId;
      }
      void queryClient.invalidateQueries({ queryKey: ['caregivers'] });
      void navigate(`/caregivers/${savedId}`);
    } catch {
      // The failure already shows as a toast (main.tsx).
    }
  }

  // Enter in a text field must not act like a button press.
  function preventEnterSubmit(event: KeyboardEvent<HTMLFormElement>): void {
    if (event.key === 'Enter' && (event.target as HTMLElement).tagName === 'INPUT') {
      event.preventDefault();
    }
  }

  const saveButton = (
    <Button
      key="save"
      type="button"
      variant="primary"
      disabled={pending || !canSave}
      onClick={() => void save()}
    >
      {pending ? 'Saving...' : 'Save'}
    </Button>
  );

  return (
    <div className="register-caregiver-page">
      <div className="register-caregiver-page__title-row">
        <h1 className="register-caregiver-page__title">
          {isEdit ? 'Edit Caregiver' : 'Register Caregiver'}
        </h1>
        {/* Editing can save from any step; registering saves at the end. */}
        {isEdit ? saveButton : null}
      </div>
      <Stepper steps={STEPS} currentStepIndex={step} />

      <form
        onSubmit={(event) => event.preventDefault()}
        onKeyDown={preventEnterSubmit}
        className="register-caregiver-page__form"
        autoComplete="off"
      >
        {step === DETAILS_STEP ? (
          <Card className="register-caregiver-page__section">
            <div className="register-caregiver-page__name-row">
              <Input
                id="caregiverFirstName"
                label="First Name"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                required
              />
              <Input
                id="caregiverLastName"
                label="Last Name"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                required
              />
            </div>
            <div className="register-caregiver-page__field">
              <label className="ds-label" htmlFor="caregiverIdType">
                ID Type
              </label>
              <select
                id="caregiverIdType"
                className="ds-input"
                value={idType}
                onChange={(e) => setIdType(e.target.value as CaregiverIdType | '')}
                required
              >
                <option value="">Select ID type</option>
                <option value="national_id">National ID</option>
                <option value="passport">Passport</option>
              </select>
            </div>
            <Input
              id="caregiverIdNumber"
              label="ID Number"
              value={idNumber}
              onChange={(e) => setIdNumber(e.target.value)}
              required
            />
            <Input
              id="caregiverEmail"
              label="Email Address"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <Input
              id="caregiverPhoneNumber"
              label="Phone Number"
              type="tel"
              placeholder="0712345678"
              hint={PHONE_HINT}
              error={
                phone.trim() !== '' && phoneNumber === null
                  ? 'Enter a Kenyan mobile number like 0712345678.'
                  : undefined
              }
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
            />
            <Input
              id="caregiverDob"
              label="Date of Birth"
              type="date"
              value={dob}
              onChange={(e) => setDob(e.target.value)}
              required
            />
            <div className="register-caregiver-page__field">
              <label className="ds-label" htmlFor="caregiverGender">
                Gender
              </label>
              <select
                id="caregiverGender"
                className="ds-input"
                value={gender}
                onChange={(e) => setGender(e.target.value as CaregiverGender | '')}
                required
              >
                <option value="">Select gender</option>
                <option value="male">Male</option>
                <option value="female">Female</option>
              </select>
            </div>
            <div className="register-caregiver-page__field">
              <label className="ds-label" htmlFor="caregiverOccupation">
                Occupation
              </label>
              <select
                id="caregiverOccupation"
                className="ds-input"
                value={occupation}
                onChange={(e) => setOccupation(e.target.value as CaregiverOccupation | '')}
                required
              >
                <option value="">Select occupation</option>
                <option value="nurse">Nurse</option>
                <option value="community_health_worker">Community Health Worker</option>
                <option value="caregiver">Caregiver</option>
              </select>
            </div>
          </Card>
        ) : null}

        {step === LOCATION_STEP ? (
          <div className="register-caregiver-page__section">
            <p className="register-caregiver-page__hint">
              Optional. The area this caregiver&rsquo;s day starts from, used to plan routes and
              find who is closest.
              {initial?.baseAreaText ? ` Currently ${initial.baseAreaText}.` : ''}
            </p>
            <LocationSelector
              initialCountyName={area?.countyName}
              initialConstituencyName={area?.constituencyName}
              initialWardName={area?.wardName}
              onWardResolved={handleAreaResolved}
            />
          </div>
        ) : null}

        {step === EXACT_LOCATION_STEP ? (
          <div className="register-caregiver-page__section">
            {area ? (
              <>
                <p className="register-caregiver-page__hint">
                  An area is enough, so don&rsquo;t pin their exact front door.
                </p>
                <ExactLocationMap
                  apiKey={getConfig().googleMapsApiKey}
                  wardFeature={area.wardFeature}
                  lat={baseLat}
                  lng={baseLng}
                  radiusMeters={0}
                  onPositionChange={(lat, lng) => {
                    setBaseLat(lat);
                    setBaseLng(lng);
                  }}
                />
              </>
            ) : (
              <p className="register-caregiver-page__hint">
                No home base will be saved. Go back and select a county, constituency and ward to
                add one.
              </p>
            )}
          </div>
        ) : null}

        {stepHint ? <p className="register-caregiver-page__step-hint">{stepHint}</p> : null}

        {/* Keys make React swap the buttons rather than reuse one, so a click on Next can't land
            on the Save that replaces it. */}
        <div className="register-caregiver-page__step-actions">
          {step > DETAILS_STEP ? (
            <Button key="back" type="button" onClick={() => setStep((s) => s - 1)}>
              Back
            </Button>
          ) : null}
          {step < EXACT_LOCATION_STEP ? (
            <Button
              key="next"
              type="button"
              variant="primary"
              disabled={!stepValid}
              onClick={() => setStep((s) => s + 1)}
            >
              Next step
            </Button>
          ) : isEdit ? null : (
            saveButton
          )}
        </div>
      </form>
    </div>
  );
}
