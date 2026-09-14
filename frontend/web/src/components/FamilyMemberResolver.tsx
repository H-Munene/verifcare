import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useApi } from '../api/useApi';
import { Button } from '../design-system/Button';
import { Input } from '../design-system/Input';
import { RadioGroup } from '../design-system/RadioGroup';
import './FamilyMemberResolver.css';

// Exactly one of cognitoSub/email is set - mirrors api/dependants.ts's AddFamilyMemberRequest
// shape (phoneNumber/fullName are always included too, since the backend schema requires them
// regardless of path - for the "existing" case they're ignored server-side, per HEZ-30's "existing
// row stays authoritative" rule, but a value must still be sent).
export interface FamilyMemberSelection {
  cognitoSub?: string;
  email?: string;
  phoneNumber: string;
  fullName: string;
}

interface FamilyMemberResolverProps {
  selection: FamilyMemberSelection | null;
  onSelect: (selection: FamilyMemberSelection | null) => void;
}

type Mode = 'existing' | 'new';

// Search-or-create UI for identifying a dependant's family contact - shared by
// RegisterDependantPage (the primary contact at registration) and DependantDetailPage's
// "+ Add Family Member" modal, since both need the identical capability. An explicit radio toggle
// (2026-09-14, user request) picks the mode up front rather than only offering "create new" as a
// fallback after a failed search: "Existing user" searches by email or phone (format-detected:
// contains "@" -> email, else phone) against GET /users; "New user" goes straight to registering a
// brand-new Cognito identity (which sends a real invitation email - see
// backend/src/auth/cognitoAdmin.ts).
export function FamilyMemberResolver({ selection, onSelect }: FamilyMemberResolverProps) {
  const { users } = useApi();
  const [mode, setMode] = useState<Mode>('existing');
  const [query, setQuery] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [roleMismatch, setRoleMismatch] = useState<string | null>(null);
  const [newEmail, setNewEmail] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newFullName, setNewFullName] = useState('');

  const searchMutation = useMutation({
    mutationFn: () => {
      const isEmail = query.includes('@');
      return users.searchUsers(isEmail ? { email: query } : { phoneNumber: query });
    },
    onSuccess: (page) => {
      const found = page.items[0];
      if (!found) {
        setNotFound(true);
        setRoleMismatch(null);
        onSelect(null);
        return;
      }
      if (found.role !== 'family_member') {
        setRoleMismatch(found.role);
        setNotFound(false);
        onSelect(null);
        return;
      }
      setNotFound(false);
      setRoleMismatch(null);
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
    setRoleMismatch(null);
    setNewEmail('');
    setNewPhone('');
    setNewFullName('');
  }

  function changeMode(next: Mode) {
    setMode(next);
    setNotFound(false);
    setRoleMismatch(null);
  }

  if (selection) {
    return (
      <div className="family-member-resolver">
        <div className="family-member-resolver__confirmed">
          {selection.cognitoSub ? (
            <>
              Linking existing user: <strong>{selection.fullName}</strong> ({selection.phoneNumber})
            </>
          ) : (
            <>
              Will register a new user: <strong>{selection.fullName}</strong> ({selection.email},{' '}
              {selection.phoneNumber}) - they will receive an email invitation with a temporary
              password.
            </>
          )}
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
                setRoleMismatch(null);
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
          {roleMismatch ? (
            <p className="family-member-resolver__error">
              This user is already registered as <strong>{roleMismatch}</strong>, not family_member,
              and can&rsquo;t be used as a family contact.
            </p>
          ) : null}
        </>
      ) : (
        <>
          <Input
            id="newFamilyMemberEmail"
            label="Email"
            type="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            autoComplete="off"
            required
          />
          <Input
            id="newFamilyMemberPhone"
            label="Phone number"
            value={newPhone}
            onChange={(e) => setNewPhone(e.target.value)}
            required
          />
          <Input
            id="newFamilyMemberFullName"
            label="Full name"
            value={newFullName}
            onChange={(e) => setNewFullName(e.target.value)}
            required
          />
          <Button
            type="button"
            variant="primary"
            disabled={!newEmail || !newPhone || !newFullName}
            onClick={() =>
              onSelect({ email: newEmail, phoneNumber: newPhone, fullName: newFullName })
            }
          >
            Use these details
          </Button>
        </>
      )}
    </div>
  );
}
