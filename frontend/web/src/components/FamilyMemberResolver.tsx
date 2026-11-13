import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import type { FamilyMemberIdType } from '../api/dependants';
import { useApi } from '../api/useApi';
import { Button } from '../design-system/Button';
import { showErrorToast } from '../design-system/toastStore';
import { Input, Label } from '../design-system/Input';
import { RadioGroup } from '../design-system/RadioGroup';
import { PHONE_HINT, toE164, toLocalPhone } from '../phone';
import './FamilyMemberResolver.css';

// Exactly one of cognitoSub/email is set - mirrors api/dependants.ts's AddFamilyMemberRequest
// shape (phoneNumber/fullName are always included too, since the backend schema requires them
// regardless of path - for the "existing" case they're ignored server-side, per HEZ-30's "existing
// row stays authoritative" rule, but a value must still be sent). idType/idNumber are only ever
// set on the "new user" (email) path - the backend requires them together with email and ignores
// them entirely on the cognitoSub path (see backend/src/routes/dependants.ts's
// addFamilyMemberRequestSchema).
export interface FamilyMemberSelection {
  cognitoSub?: string;
  email?: string;
  phoneNumber: string;
  fullName: string;
  idType?: FamilyMemberIdType;
  idNumber?: string;
}

interface FamilyMemberResolverProps {
  selection: FamilyMemberSelection | null;
  onSelect: (selection: FamilyMemberSelection | null) => void;
}

type Mode = 'existing' | 'new';

interface NewFamilyMemberFields {
  firstName: string;
  lastName: string;
  phoneNumber: string;
  email: string;
  idType: FamilyMemberIdType | '';
  idNumber: string;
}

const EMPTY_NEW_FIELDS: NewFamilyMemberFields = {
  firstName: '',
  lastName: '',
  phoneNumber: '',
  email: '',
  idType: '',
  idNumber: '',
};

function idNumberLabel(idType: NewFamilyMemberFields['idType']): string {
  if (idType === 'passport') {
    return 'Passport Number';
  }
  if (idType === 'national_id') {
    return 'National ID Number';
  }
  return 'ID Number';
}

// Search-or-create UI for identifying a dependant's family contact - shared by
// RegisterDependantPage (the primary contact, and each additional contact) and
// DependantDetailPage's "+ Add Family Member" modal, since all three need the identical
// capability. An explicit radio toggle (2026-09-14, user request) picks the mode up front rather
// than only offering "create new" as a fallback after a failed search: "Existing user" searches by
// email or phone (format-detected: contains "@" -> email, else phone) against GET /users; "New
// user" goes straight to registering a brand-new Cognito identity (which sends a real invitation
// email - see backend/src/auth/cognitoAdmin.ts).
//
// "New user" mode has no separate confirm step (2026-09-21 revision, removing the earlier "Use
// these details" button) - its fields are always visible and editable, and every keystroke
// recomputes and reports the current selection (or null while any required field is still empty)
// directly to the parent, the same way a plain form field would. This is why the "confirmed
// summary, click Change to edit" view below is now gated on `selection?.cognitoSub` specifically,
// not just `selection` being non-null: an "existing" search result is a real confirmed action (a
// round trip already happened), but a fully-typed "new user" draft is not - collapsing the form
// the moment the last required character was typed would yank the fields away mid-edit.
export function FamilyMemberResolver({ selection, onSelect }: FamilyMemberResolverProps) {
  const { users } = useApi();
  const [mode, setMode] = useState<Mode>('existing');
  const [query, setQuery] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [newFields, setNewFields] = useState<NewFamilyMemberFields>(EMPTY_NEW_FIELDS);

  const searchMutation = useMutation({
    mutationFn: () => {
      const isEmail = query.includes('@');
      return users.searchUsers(
        isEmail ? { email: query.trim() } : { phoneNumber: toE164(query) ?? query.trim() },
      );
    },
    onSuccess: (page) => {
      const found = page.items[0];
      if (!found) {
        setNotFound(true);
        onSelect(null);
        return;
      }
      if (found.role !== 'family_member') {
        showErrorToast(
          `This user is registered as ${found.role.replace('_', ' ')}, so they can't be a family contact.`,
        );
        setNotFound(false);
        onSelect(null);
        return;
      }
      setNotFound(false);
      onSelect({
        cognitoSub: found.cognitoSub,
        phoneNumber: found.phoneNumber ?? '',
        fullName: found.fullName,
      });
    },
  });

  function reset() {
    onSelect(null);
    setMode('existing');
    setQuery('');
    setNotFound(false);
    setNewFields(EMPTY_NEW_FIELDS);
  }

  function changeMode(next: Mode) {
    setMode(next);
    setNotFound(false);
    setNewFields(EMPTY_NEW_FIELDS);
    // The previous mode's selection (an existing-user match, or a completed new-user draft) no
    // longer matches what's now on screen - clearing it here, rather than only on the fields
    // actually changing, closes the gap where switching modes right after completing one would
    // otherwise leave the parent holding a stale, wrong-shaped selection.
    onSelect(null);
  }

  function updateNewFields(patch: Partial<NewFamilyMemberFields>) {
    const next = { ...newFields, ...patch };
    setNewFields(next);
    const phoneNumber = toE164(next.phoneNumber);
    const complete =
      next.firstName.trim() !== '' &&
      next.lastName.trim() !== '' &&
      phoneNumber !== null &&
      next.email.trim() !== '' &&
      next.idType !== '' &&
      next.idNumber.trim() !== '';
    onSelect(
      complete
        ? {
            email: next.email,
            phoneNumber,
            fullName: `${next.firstName.trim()} ${next.lastName.trim()}`.trim(),
            idType: next.idType || undefined,
            idNumber: next.idNumber,
          }
        : null,
    );
  }

  if (selection?.cognitoSub) {
    return (
      <div className="family-member-resolver">
        <div className="family-member-resolver__confirmed">
          Linking existing user: <strong>{selection.fullName}</strong> (
          {toLocalPhone(selection.phoneNumber)})
        </div>
        <Button type="button" onClick={reset}>
          Change
        </Button>
      </div>
    );
  }

  return (
    <div className="family-member-resolver">
      <RadioGroup
        name="familyMemberMode"
        value={mode}
        onChange={changeMode}
        options={[
          { value: 'existing', label: 'Existing user' },
          { value: 'new', label: 'New user' },
        ]}
      />

      {mode === 'existing' ? (
        <>
          <div className="family-member-resolver__search">
            <Input
              id="familyMemberSearch"
              label="Search by email or phone number"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setNotFound(false);
              }}
            />
            <Button
              type="button"
              onClick={() => searchMutation.mutate()}
              disabled={!query || searchMutation.isPending}
            >
              {searchMutation.isPending ? 'Searching...' : 'Search'}
            </Button>
          </div>
          {notFound ? (
            <p className="family-member-resolver__hint">
              No user found matching &ldquo;{query}&rdquo;. Switch to &ldquo;New user&rdquo; above
              to register them.
            </p>
          ) : null}
        </>
      ) : (
        <>
          <div className="family-member-resolver__row">
            <Input
              id="newFamilyMemberFirstName"
              label="First Name"
              value={newFields.firstName}
              onChange={(e) => updateNewFields({ firstName: e.target.value })}
              required
            />
            <Input
              id="newFamilyMemberLastName"
              label="Last Name"
              value={newFields.lastName}
              onChange={(e) => updateNewFields({ lastName: e.target.value })}
              required
            />
          </div>
          <div className="family-member-resolver__field">
            <Label htmlFor="newFamilyMemberIdType" required>
              ID Type
            </Label>
            <select
              id="newFamilyMemberIdType"
              className="ds-input"
              value={newFields.idType}
              onChange={(e) =>
                updateNewFields({ idType: e.target.value as FamilyMemberIdType | '' })
              }
              required
            >
              <option value="">Select ID type</option>
              <option value="national_id">National ID</option>
              <option value="passport">Passport</option>
            </select>
          </div>
          <Input
            id="newFamilyMemberIdNumber"
            label={idNumberLabel(newFields.idType)}
            value={newFields.idNumber}
            onChange={(e) => updateNewFields({ idNumber: e.target.value })}
            required
          />
          <div className="family-member-resolver__row">
            <Input
              id="newFamilyMemberPhone"
              label="Phone Number"
              type="tel"
              placeholder="0712345678"
              hint={PHONE_HINT}
              error={
                newFields.phoneNumber.trim() !== '' && !toE164(newFields.phoneNumber)
                  ? 'Enter a Kenyan mobile number like 0712345678.'
                  : undefined
              }
              value={newFields.phoneNumber}
              onChange={(e) => updateNewFields({ phoneNumber: e.target.value })}
              required
            />
            <Input
              id="newFamilyMemberEmail"
              label="Email Address"
              type="email"
              value={newFields.email}
              onChange={(e) => updateNewFields({ email: e.target.value })}
              autoComplete="off"
              required
            />
          </div>
        </>
      )}
    </div>
  );
}
