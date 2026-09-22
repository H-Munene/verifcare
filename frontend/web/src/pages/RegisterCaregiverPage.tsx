import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { BiometricEnrollment } from '../api/biometricEnrollments';
import { uploadFileToPresignedUrl } from '../api/biometricEnrollments';
import { ApiError } from '../api/client';
import type {
  Caregiver,
  CaregiverGender,
  CaregiverIdType,
  CaregiverOccupation,
  CognitoLookupResult,
} from '../api/caregivers';
import { useApi } from '../api/useApi';
import { useAuth } from '../auth/AuthContext';
import { Button } from '../design-system/Button';
import { Card } from '../design-system/Card';
import { Input } from '../design-system/Input';
import { Stepper } from '../design-system/Stepper';
import './RegisterCaregiverPage.css';

// Replaces the earlier single-section form (2026-09-22) - caregivers are professional individuals
// needing more identity/professional detail than Full Name/Phone alone, and the backend contract
// changed under this page: employeeNumber/hireDate are no longer client-supplied at all (server
// auto-generates both), while fullName/email/phoneNumber/idType/idNumber/dob/gender/occupation are
// now all required. Rebuilt as a two-step wizard - Details, then Photo - mirroring
// RegisterDependantPage.tsx's own stepper architecture, since caregiver check-in verification
// needs the same single enrolled photo a dependant's own check-in co-presence step already
// requires (see BiometricEnrollmentSection.tsx/api/biometricEnrollments.ts, reused unchanged here
// with subjectType 'caregiver').
//
// Only two steps, unlike RegisterDependantPage's six - there's no location/geofence/family-contact
// data on a caregiver, so Details collects everything in one step and Photo is purely the
// biometric enrollment trailer. Photo is registration-only (edit mode has no Photo step): editing
// an already-enrolled caregiver's photo happens from CaregiverDetailPage's own
// BiometricEnrollmentSection instead, matching this page's pre-existing edit-mode behavior.
//
// This outer component only decides *when* to render the form - CaregiverForm below isn't
// rendered until the existing caregiver (in edit mode) has actually loaded, so its field state can
// be initialized directly from real data via plain useState (no react-hooks/set-state-in-effect
// anti-pattern).
export function RegisterCaregiverPage() {
  const { caregiverId } = useParams<{ caregiverId: string }>();
  const isEdit = Boolean(caregiverId);
  const { caregivers } = useApi();
  const { identity } = useAuth();

  // Every /caregivers route (including this one) is supervisor-only on the backend - a caregiver
  // can never self-register, confirmed with the user. CaregiversListPage already hides the entry
  // point to this page for a non-supervisor, but this guards direct URL access too, with a clear
  // message rather than a confusing failed request once they try to save.
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
    return <p>Loading...</p>;
  }
  if (isEdit && (existing.isError || !existing.data)) {
    return <p>Failed to load this caregiver.</p>;
  }

  return <CaregiverForm caregiverId={caregiverId} initial={existing.data} />;
}

// The backend only ever stores one fullName string - splitting it into two display fields is a
// pure UI convenience, matching RegisterDependantPage.tsx's own splitFullName helper exactly
// rather than reinventing it, so editing an existing caregiver re-derives first/last from that one
// string the same (ambiguous-past-two-words) way.
function splitFullName(fullName: string): { firstName: string; lastName: string } {
  const trimmed = fullName.trim();
  const spaceIndex = trimmed.indexOf(' ');
  if (spaceIndex === -1) {
    return { firstName: trimmed, lastName: '' };
  }
  return { firstName: trimmed.slice(0, spaceIndex), lastName: trimmed.slice(spaceIndex + 1) };
}

function CaregiverForm({ caregiverId, initial }: { caregiverId?: string; initial?: Caregiver }) {
  const isEdit = Boolean(caregiverId);
  const { caregivers, biometricEnrollments } = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const steps = isEdit ? ['Details'] : ['Details', 'Photo'];
  const [step, setStep] = useState(0);
  const detailsStepIndex = 0;
  const photoStepIndex = steps.length - 1;
  const isPhotoStep = !isEdit && step === photoStepIndex;

  // Registration-only: cognitoSub is set once at creation and never changes, so editing skips the
  // lookup step entirely - there's no self-signup flow yet, so a supervisor must resolve an
  // already-existing Cognito identity by email before POST /caregivers will accept it.
  const [lookupEmail, setLookupEmail] = useState('');
  const [cognitoSub, setCognitoSub] = useState<string | null>(null);
  const [lookupResult, setLookupResult] = useState<CognitoLookupResult | null>(null);
  const [lookupNotFound, setLookupNotFound] = useState(false);

  const lookupMutation = useMutation({
    mutationFn: () => caregivers.lookupCognitoByEmail(lookupEmail),
    onSuccess: (result) => {
      setLookupNotFound(false);
      setLookupResult(result);
      setCognitoSub(result.cognitoSub);
      if (result.fullName) {
        const split = splitFullName(result.fullName);
        setFirstName(split.firstName);
        setLastName(split.lastName);
      }
      if (result.phoneNumber) {
        setPhoneNumber(result.phoneNumber);
      }
      setEmail(result.email);
    },
    onError: (error) => {
      setLookupResult(null);
      setCognitoSub(null);
      setLookupNotFound(error instanceof ApiError && error.problem.status === 404);
    },
  });

  function resetLookup() {
    setLookupResult(null);
    setCognitoSub(null);
    setLookupNotFound(false);
    setLookupEmail('');
    setFirstName('');
    setLastName('');
    setPhoneNumber('');
    setEmail('');
  }

  const initialName = splitFullName(initial?.fullName ?? '');
  const [firstName, setFirstName] = useState(initialName.firstName);
  const [lastName, setLastName] = useState(initialName.lastName);
  const [email, setEmail] = useState(initial?.email ?? '');
  const [phoneNumber, setPhoneNumber] = useState(initial?.phoneNumber ?? '');
  const [idType, setIdType] = useState<CaregiverIdType | ''>(initial?.idType ?? '');
  const [idNumber, setIdNumber] = useState(initial?.idNumber ?? '');
  const [dob, setDob] = useState(initial?.dob ?? '');
  const [gender, setGender] = useState<CaregiverGender | ''>(initial?.gender ?? '');
  const [occupation, setOccupation] = useState<CaregiverOccupation | ''>(initial?.occupation ?? '');

  // Set once the caregiver is actually created (see submitForm below), which is what unlocks the
  // Photo step - biometric-enrollments' own FK check requires this id to already exist.
  const [createdCaregiverId, setCreatedCaregiverId] = useState<string | null>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoResult, setPhotoResult] = useState<BiometricEnrollment | null>(null);

  const createMutation = useMutation({ mutationFn: caregivers.createCaregiver });
  const updateMutation = useMutation({
    mutationFn: (body: Parameters<typeof caregivers.updateCaregiver>[1]) =>
      caregivers.updateCaregiver(caregiverId!, body),
  });

  // Single required photo, imageOrder fixed at 1 - mirrors RegisterDependantPage.tsx's own Photo
  // step exactly (see that file's header comment for why this exists and why it's just one image).
  const photoMutation = useMutation({
    mutationFn: async () => {
      if (!photoFile || !createdCaregiverId) {
        throw new Error('Choose a photo first.');
      }
      if (!['image/jpeg', 'image/png'].includes(photoFile.type)) {
        throw new Error('Only JPEG or PNG images are accepted.');
      }
      const contentType = photoFile.type as 'image/jpeg' | 'image/png';
      const presigned = await biometricEnrollments.createUploadUrl({
        subjectType: 'caregiver',
        subjectId: createdCaregiverId,
        imageOrder: 1,
        contentType,
      });
      await uploadFileToPresignedUrl(presigned.uploadUrl, photoFile);
      return biometricEnrollments.confirmEnrollment({
        subjectType: 'caregiver',
        subjectId: createdCaregiverId,
        s3Key: presigned.s3Key,
        imageOrder: 1,
      });
    },
    onSuccess: (enrollment) => setPhotoResult(enrollment),
  });

  const formUnlocked = isEdit || Boolean(cognitoSub);
  const detailsValid =
    formUnlocked &&
    firstName.trim() !== '' &&
    lastName.trim() !== '' &&
    email.trim() !== '' &&
    phoneNumber.trim() !== '' &&
    idType !== '' &&
    idNumber.trim() !== '' &&
    dob !== '' &&
    gender !== '' &&
    occupation !== '';
  const pending = createMutation.isPending || updateMutation.isPending;
  const mutationError = createMutation.error ?? updateMutation.error;

  async function submitForm() {
    if (!detailsValid) {
      return;
    }
    const common = {
      fullName: `${firstName} ${lastName}`.trim(),
      email,
      phoneNumber,
      idType,
      idNumber,
      dob,
      gender,
      occupation,
    };

    if (isEdit) {
      try {
        await updateMutation.mutateAsync(common);
        void queryClient.invalidateQueries({ queryKey: ['caregivers'] });
        void queryClient.invalidateQueries({ queryKey: ['caregiver', caregiverId] });
        void navigate(`/caregivers/${caregiverId}`);
      } catch {
        // updateMutation's own `error` state (surfaced via mutationError below) already reports
        // this - nothing further to do here.
      }
      return;
    }

    if (!cognitoSub) {
      return;
    }

    try {
      const caregiver = await createMutation.mutateAsync({ ...common, cognitoSub });
      void queryClient.invalidateQueries({ queryKey: ['caregivers'] });
      // Don't navigate yet - advance into the Photo step instead, now that a real caregiver id
      // exists for it to enroll a photo against.
      setCreatedCaregiverId(caregiver.userId);
      setStep((s) => s + 1);
    } catch {
      // createMutation's own `error` state (surfaced via mutationError below) already reports
      // this - nothing further to do here.
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void submitForm();
  }

  // The Details step has a real type="submit" Save button in the DOM (rendered whenever step !==
  // photoStepIndex), so pressing Enter in any plain text input implicitly submits the form once
  // every required field happens to already be filled - a real bug found and fixed the same way in
  // RegisterDependantPage.tsx's Additional Contacts step. Scoped to <input> targets only, so Enter
  // on a focused button still activates it normally.
  function preventEnterSubmit(event: KeyboardEvent<HTMLFormElement>): void {
    if (event.key === 'Enter' && (event.target as HTMLElement).tagName === 'INPUT') {
      event.preventDefault();
    }
  }

  return (
    <div className="register-caregiver-page">
      <h1 className="register-caregiver-page__title">
        {isEdit ? 'Edit Caregiver' : 'Register Caregiver'}
      </h1>
      <Stepper steps={steps} currentStepIndex={step} />

      <form
        onSubmit={handleSubmit}
        onKeyDown={preventEnterSubmit}
        className="register-caregiver-page__form"
        autoComplete="off"
      >
        {step === detailsStepIndex ? (
          <>
            {!isEdit ? (
              <Card className="register-caregiver-page__section">
                <div className="register-caregiver-page__section-title">Caregiver identity</div>
                {cognitoSub && lookupResult ? (
                  <div className="register-caregiver-page__lookup-confirmed">
                    <div>
                      Linking existing Cognito user: <strong>{lookupResult.email}</strong>
                    </div>
                    <Button type="button" onClick={resetLookup}>
                      Change
                    </Button>
                  </div>
                ) : (
                  <>
                    <p className="register-caregiver-page__hint">
                      The caregiver must already have a Cognito account (there is no caregiver
                      self-signup flow yet) - look them up by the email address they use to sign in.
                    </p>
                    <div className="register-caregiver-page__lookup-row">
                      <Input
                        id="lookupEmail"
                        label="Email address"
                        type="email"
                        value={lookupEmail}
                        onChange={(e) => {
                          setLookupEmail(e.target.value);
                          setLookupNotFound(false);
                        }}
                        autoComplete="off"
                      />
                      <Button
                        type="button"
                        onClick={() => lookupMutation.mutate()}
                        disabled={!lookupEmail || lookupMutation.isPending}
                      >
                        {lookupMutation.isPending ? 'Looking up...' : 'Look up'}
                      </Button>
                    </div>
                    {lookupNotFound ? (
                      <p className="register-caregiver-page__error">
                        No Cognito user found with this email - the caregiver must already have a
                        Cognito account before they can be registered here. There is currently no
                        way to create one from this UI (a known gap tied to the caregiver mobile app
                        not existing yet, HEZ-63/64).
                      </p>
                    ) : null}
                    {lookupMutation.error && !lookupNotFound ? (
                      <p className="register-caregiver-page__error">
                        {lookupMutation.error instanceof ApiError
                          ? (lookupMutation.error.problem.detail ??
                            lookupMutation.error.problem.title)
                          : 'Something went wrong.'}
                      </p>
                    ) : null}
                  </>
                )}
              </Card>
            ) : null}

            <Card className="register-caregiver-page__section">
              <div className="register-caregiver-page__name-row">
                <Input
                  id="caregiverFirstName"
                  label="First Name"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  disabled={!formUnlocked}
                  required
                />
                <Input
                  id="caregiverLastName"
                  label="Last Name"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  disabled={!formUnlocked}
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
                  disabled={!formUnlocked}
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
                disabled={!formUnlocked}
                required
              />
              <Input
                id="caregiverEmail"
                label="Email Address"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={!formUnlocked}
                required
              />
              <Input
                id="caregiverPhoneNumber"
                label="Phone Number"
                type="tel"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                disabled={!formUnlocked}
                required
              />
              <Input
                id="caregiverDob"
                label="Date of Birth"
                type="date"
                value={dob}
                onChange={(e) => setDob(e.target.value)}
                disabled={!formUnlocked}
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
                  disabled={!formUnlocked}
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
                  disabled={!formUnlocked}
                  required
                >
                  <option value="">Select occupation</option>
                  <option value="nurse">Nurse</option>
                  <option value="community_health_worker">Community Health Worker</option>
                  <option value="caregiver">Caregiver</option>
                </select>
              </div>
            </Card>
          </>
        ) : null}

        {isPhotoStep && createdCaregiverId ? (
          <Card className="register-caregiver-page__section">
            <div className="register-caregiver-page__section-title">Caregiver&rsquo;s photo</div>
            <p className="register-caregiver-page__hint">
              This lets check-in verify {firstName || 'the caregiver'}&rsquo;s identity at the start
              of a visit. Optional for now - you can add or replace it later from the
              caregiver&rsquo;s detail page instead.
            </p>
            {photoResult ? (
              <>
                <p>
                  {photoResult.status === 'flagged'
                    ? `This photo matched an already-enrolled ${photoResult.matchedSubjectType} at ${photoResult.matchedSimilarity?.toFixed(1)}% similarity - it's been flagged for a supervisor to review on the Flagged Enrollments page, and hasn't been activated.`
                    : `Uploaded and activated - quality score ${photoResult.qualityScore?.toFixed(1) ?? 'n/a'}.`}
                </p>
                <div className="register-caregiver-page__step-actions">
                  <Button
                    type="button"
                    variant="primary"
                    onClick={() => void navigate(`/caregivers/${createdCaregiverId}`)}
                  >
                    Finish
                  </Button>
                </div>
              </>
            ) : (
              <>
                <Input
                  id="caregiverPhoto"
                  type="file"
                  label="Photo (JPEG or PNG)"
                  accept="image/jpeg,image/png"
                  onChange={(e) => setPhotoFile(e.target.files?.[0] ?? null)}
                />
                {photoMutation.error ? (
                  <div className="register-caregiver-page__error">
                    {photoMutation.error instanceof Error
                      ? photoMutation.error.message
                      : 'Something went wrong.'}
                  </div>
                ) : null}
                <div className="register-caregiver-page__step-actions">
                  <Button
                    type="button"
                    onClick={() => void navigate(`/caregivers/${createdCaregiverId}`)}
                  >
                    Skip for now
                  </Button>
                  <Button
                    type="button"
                    variant="primary"
                    disabled={photoMutation.isPending || !photoFile}
                    onClick={() => photoMutation.mutate()}
                  >
                    {photoMutation.isPending ? 'Uploading...' : 'Upload & Finish'}
                  </Button>
                </div>
              </>
            )}
          </Card>
        ) : null}

        {mutationError ? (
          <div className="register-caregiver-page__error">
            {mutationError instanceof ApiError
              ? (mutationError.problem.detail ?? mutationError.problem.title)
              : 'Something went wrong.'}
          </div>
        ) : null}

        {isPhotoStep ? null : (
          <div className="register-caregiver-page__step-actions">
            <Button type="submit" variant="primary" disabled={pending || !detailsValid}>
              {pending ? 'Saving...' : 'Save'}
            </Button>
          </div>
        )}
      </form>
    </div>
  );
}
