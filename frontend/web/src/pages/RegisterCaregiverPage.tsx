import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import type {
  Caregiver,
  CaregiverGender,
  CaregiverIdType,
  CaregiverOccupation,
} from '../api/caregivers';
import { useApi } from '../api/useApi';
import { useAuth } from '../auth/AuthContext';
import { Button } from '../design-system/Button';
import { Card } from '../design-system/Card';
import { Input } from '../design-system/Input';
import './RegisterCaregiverPage.css';
import { DetailSkeleton } from '../design-system/Skeleton';

// Replaces the earlier single-section form (2026-09-22) - caregivers are professional individuals
// needing more identity/professional detail than Full Name/Phone alone, and the backend contract
// changed under this page: employeeNumber/hireDate are no longer client-supplied at all (server
// auto-generates both), while fullName/email/phoneNumber/idType/idNumber/dob/gender/occupation are
// now all required.
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
    return <DetailSkeleton />;
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
  const { caregivers } = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

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

  const createMutation = useMutation({ mutationFn: caregivers.createCaregiver });
  const updateMutation = useMutation({
    mutationFn: (body: Parameters<typeof caregivers.updateCaregiver>[1]) =>
      caregivers.updateCaregiver(caregiverId!, body),
  });

  const detailsValid =
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

    try {
      const caregiver = await createMutation.mutateAsync(common);
      void queryClient.invalidateQueries({ queryKey: ['caregivers'] });
      void navigate(`/caregivers/${caregiver.userId}`);
    } catch {
      // createMutation's own `error` state (surfaced via mutationError below) already reports
      // this - nothing further to do here.
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void submitForm();
  }

  // The form has a real type="submit" Save button, so pressing Enter in any plain text input implicitly submits the form once
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

      <form
        onSubmit={handleSubmit}
        onKeyDown={preventEnterSubmit}
        className="register-caregiver-page__form"
        autoComplete="off"
      >
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
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value)}
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
        {mutationError ? (
          <div className="register-caregiver-page__error">
            {mutationError instanceof ApiError
              ? (mutationError.problem.detail ?? mutationError.problem.title)
              : 'Something went wrong.'}
          </div>
        ) : null}

        <div className="register-caregiver-page__step-actions">
          <Button type="submit" variant="primary" disabled={pending || !detailsValid}>
            {pending ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </form>
    </div>
  );
}
