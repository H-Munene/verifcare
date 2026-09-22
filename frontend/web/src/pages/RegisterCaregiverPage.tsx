import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Caregiver, CognitoLookupResult } from '../api/caregivers';
import { ApiError } from '../api/client';
import { useApi } from '../api/useApi';
import { useAuth } from '../auth/AuthContext';
import { Button } from '../design-system/Button';
import { Card } from '../design-system/Card';
import { Input } from '../design-system/Input';
import './RegisterCaregiverPage.css';

// Handles both registration (no :caregiverId in the route) and editing, mirroring
// RegisterDependantPage.tsx's isEdit pattern. This outer component only decides *when* to render
// the form - CaregiverForm below isn't rendered until the existing caregiver (in edit mode) has
// actually loaded, so its field state can be initialized directly from real data via plain
// useState (no react-hooks/set-state-in-effect anti-pattern).
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

function CaregiverForm({ caregiverId, initial }: { caregiverId?: string; initial?: Caregiver }) {
  const isEdit = Boolean(caregiverId);
  const { caregivers } = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // Registration-only: cognitoSub is set once at creation and never changes, so editing skips the
  // lookup step entirely (see the file's task brief - there's no self-signup flow yet, so a
  // supervisor must resolve an already-existing Cognito identity by email before POST /caregivers
  // will accept it).
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
        setFullName(result.fullName);
      }
      if (result.phoneNumber) {
        setPhoneNumber(result.phoneNumber);
      }
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
    setFullName('');
    setPhoneNumber('');
  }

  const [fullName, setFullName] = useState(initial?.fullName ?? '');
  const [phoneNumber, setPhoneNumber] = useState(initial?.phoneNumber ?? '');
  const [employeeNumber, setEmployeeNumber] = useState(initial?.employeeNumber ?? '');
  const [hireDate, setHireDate] = useState(initial?.hireDate ?? '');

  const createMutation = useMutation({
    mutationFn: caregivers.createCaregiver,
    onSuccess: (caregiver) => {
      void queryClient.invalidateQueries({ queryKey: ['caregivers'] });
      void navigate(`/caregivers/${caregiver.userId}`);
    },
  });
  const updateMutation = useMutation({
    mutationFn: (body: Parameters<typeof caregivers.updateCaregiver>[1]) =>
      caregivers.updateCaregiver(caregiverId!, body),
    onSuccess: (caregiver) => {
      void queryClient.invalidateQueries({ queryKey: ['caregivers'] });
      void queryClient.invalidateQueries({ queryKey: ['caregiver', caregiverId] });
      void navigate(`/caregivers/${caregiver.userId}`);
    },
  });

  const formUnlocked = isEdit || Boolean(cognitoSub);
  const detailsValid = fullName.trim() !== '' && phoneNumber.trim() !== '';
  const pending = createMutation.isPending || updateMutation.isPending;
  const mutationError = createMutation.error ?? updateMutation.error;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!detailsValid) {
      return;
    }
    const common = {
      fullName,
      phoneNumber,
      employeeNumber: employeeNumber || undefined,
      hireDate: hireDate || undefined,
    };
    if (isEdit) {
      updateMutation.mutate(common);
      return;
    }
    if (!cognitoSub) {
      return;
    }
    createMutation.mutate({ ...common, cognitoSub });
  }

  return (
    <div className="register-caregiver-page">
      <h1 className="register-caregiver-page__title">
        {isEdit ? 'Edit Caregiver' : 'Register Caregiver'}
      </h1>

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
                The caregiver must already have a Cognito account (there is no caregiver self-signup
                flow yet) - look them up by the email address they use to sign in.
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
                  No Cognito user found with this email - the caregiver must already have a Cognito
                  account before they can be registered here. There is currently no way to create
                  one from this UI (a known gap tied to the caregiver mobile app not existing yet,
                  HEZ-63/64).
                </p>
              ) : null}
              {lookupMutation.error && !lookupNotFound ? (
                <p className="register-caregiver-page__error">
                  {lookupMutation.error instanceof ApiError
                    ? (lookupMutation.error.problem.detail ?? lookupMutation.error.problem.title)
                    : 'Something went wrong.'}
                </p>
              ) : null}
            </>
          )}
        </Card>
      ) : null}

      <form onSubmit={handleSubmit} className="register-caregiver-page__form" autoComplete="off">
        {/* Disabled (rather than hidden) until formUnlocked, matching FamilyMemberResolver's
            "fields always visible" style but blocking edits: cognitoSub isn't required to see the
            fields exist, only to actually save. Always unlocked in edit mode - see the file header
            comment. */}
        <Card className="register-caregiver-page__section">
          <Input
            id="caregiverFullName"
            label="Full Name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
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
            id="caregiverEmployeeNumber"
            label="Employee Number"
            value={employeeNumber}
            onChange={(e) => setEmployeeNumber(e.target.value)}
            disabled={!formUnlocked}
          />
          <Input
            id="caregiverHireDate"
            label="Hire Date"
            type="date"
            value={hireDate}
            onChange={(e) => setHireDate(e.target.value)}
            disabled={!formUnlocked}
          />
        </Card>

        {mutationError ? (
          <div className="register-caregiver-page__error">
            {mutationError instanceof ApiError
              ? (mutationError.problem.detail ?? mutationError.problem.title)
              : 'Something went wrong.'}
          </div>
        ) : null}

        <div className="register-caregiver-page__step-actions">
          <Button
            type="submit"
            variant="primary"
            disabled={pending || !detailsValid || !formUnlocked}
          >
            {pending ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </form>
    </div>
  );
}
