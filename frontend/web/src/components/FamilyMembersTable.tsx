import { Call02Icon, Link01Icon, UserIcon } from '@hugeicons/core-free-icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '../api/client';
import type { DependantFamilyMember } from '../api/dependants';
import { useApi } from '../api/useApi';
import { useAuth } from '../auth/AuthContext';
import { Button } from '../design-system/Button';
import { ConfirmDialog } from '../design-system/ConfirmDialog';
import { SidePanel } from '../design-system/SidePanel';
import { TableSkeleton } from '../design-system/Skeleton';
import { TableFrame, Th } from '../design-system/Table';
import { Tag } from '../design-system/Tag';
import './FamilyMembersTable.css';

// The dependant page's Family tab (2026-09-27, user request): members in a table - name,
// relationship, then whether they're the primary or a secondary contact - and a member's full
// details in a side panel, replacing the old expandable rows. Changing the primary contact moved
// into the panel behind a confirmation, since it changes who may edit the dependant and who
// decides relatives' link requests (routes/dependants.ts, routes/familyLinkRequests.ts).

const ID_TYPE_LABELS: Record<'national_id' | 'passport', string> = {
  national_id: 'National ID',
  passport: 'Passport',
};

function ContactTag({ member }: { member: DependantFamilyMember }) {
  return member.isPrimaryContact ? (
    <Tag>Primary contact</Tag>
  ) : (
    <Tag tone="neutral">Secondary contact</Tag>
  );
}

export function FamilyMembersTable({
  dependantId,
  dependantName,
  members,
  isLoading,
  isError,
}: {
  dependantId: string;
  dependantName: string;
  members: DependantFamilyMember[] | undefined;
  isLoading: boolean;
  isError: boolean;
}) {
  // By id, not a copy of the row, so the panel shows the list's latest data after a change.
  const [openMemberId, setOpenMemberId] = useState<string | null>(null);
  const openMember = members?.find((m) => m.familyMemberUserId === openMemberId);

  if (isLoading) {
    return <TableSkeleton columns={3} rows={2} />;
  }
  if (isError || !members) {
    return <p className="family-members__empty">Family members couldn&rsquo;t be loaded.</p>;
  }

  return (
    <>
      <TableFrame>
        <table className="ds-table ds-table--table-cell">
          <thead>
            <tr>
              <Th icon={UserIcon}>Name</Th>
              <Th icon={Link01Icon}>Relationship</Th>
              <Th icon={Call02Icon}>Contact</Th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr
                key={member.familyMemberUserId}
                className="ds-table__row--link"
                onClick={() => setOpenMemberId(member.familyMemberUserId)}
              >
                <td>
                  {/* A real button, so the keyboard reaches what the row's click does. */}
                  <button
                    type="button"
                    className="family-members__name"
                    aria-haspopup="dialog"
                    onClick={(event) => {
                      event.stopPropagation();
                      setOpenMemberId(member.familyMemberUserId);
                    }}
                  >
                    {member.fullName}
                  </button>
                </td>
                <td className={member.relationship ? undefined : 'family-members__unset'}>
                  {member.relationship ?? 'Not set'}
                </td>
                <td>
                  <ContactTag member={member} />
                </td>
              </tr>
            ))}
            {members.length === 0 ? (
              <tr>
                <td colSpan={3} className="ds-table__empty">
                  No family members linked yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </TableFrame>

      {openMember ? (
        <FamilyMemberPanel
          dependantId={dependantId}
          dependantName={dependantName}
          member={openMember}
          currentPrimary={members.find((m) => m.isPrimaryContact)}
          onClose={() => setOpenMemberId(null)}
        />
      ) : null}
    </>
  );
}

function FamilyMemberPanel({
  dependantId,
  dependantName,
  member,
  currentPrimary,
  onClose,
}: {
  dependantId: string;
  dependantName: string;
  member: DependantFamilyMember;
  currentPrimary: DependantFamilyMember | undefined;
  onClose: () => void;
}) {
  const { dependants } = useApi();
  const { identity } = useAuth();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  // PATCH .../family-members/{userId} is supervisor-only (HEZ-30) - gated on the caller's actual
  // role rather than assumed, the same way RegisterDependantPage gates the status field.
  const canMakePrimary = identity?.role === 'supervisor' && !member.isPrimaryContact;

  const makePrimary = useMutation({
    mutationFn: () =>
      dependants.updateFamilyMember(dependantId, member.familyMemberUserId, {
        isPrimaryContact: true,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['dependant', dependantId, 'family-members'],
      });
      setConfirming(false);
    },
  });

  const linkedOn = new Date(member.createdAt).toLocaleDateString('en-KE', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  const details: [string, string][] = [
    ['Email', member.email ?? 'Not recorded'],
    ['Phone', member.phoneNumber ?? 'Not recorded'],
    ['Relationship', member.relationship ?? 'Not set'],
    ['Added by', member.addedByName ?? 'Unknown'],
    ['Linked on', linkedOn],
  ];
  // The API only includes the ID document for a supervisor; shown whenever it's in the response.
  if ('idType' in member) {
    details.push([
      'ID document',
      member.idType && member.idNumber
        ? `${ID_TYPE_LABELS[member.idType]} · ${member.idNumber}`
        : 'Not recorded',
    ]);
  }

  return (
    <SidePanel
      eyebrow={`Family member of ${dependantName}`}
      title={member.fullName}
      onClose={onClose}
      footer={
        canMakePrimary ? (
          <div className="family-members__footer">
            <Button variant="primary" onClick={() => setConfirming(true)}>
              Make primary contact
            </Button>
          </div>
        ) : undefined
      }
    >
      <div className="family-members__panel-tag">
        <ContactTag member={member} />
      </div>
      <dl className="family-members__details">
        {details.map(([label, value]) => (
          <div key={label} className="family-members__detail">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      {confirming ? (
        <ConfirmDialog
          title="Change the primary contact?"
          message={
            <>
              <p>
                Make {member.fullName} the primary contact for {dependantName}?
              </p>
              <p>
                The primary contact can edit {dependantName}&rsquo;s details and decides requests
                from other relatives to be linked.
                {currentPrimary
                  ? ` ${currentPrimary.fullName} will become a secondary contact.`
                  : ''}
              </p>
            </>
          }
          confirmLabel="Make primary contact"
          pendingLabel="Changing..."
          pending={makePrimary.isPending}
          error={
            makePrimary.error
              ? makePrimary.error instanceof ApiError
                ? (makePrimary.error.problem.detail ?? makePrimary.error.problem.title)
                : 'Something went wrong. Try again.'
              : undefined
          }
          onConfirm={() => makePrimary.mutate()}
          onCancel={() => {
            setConfirming(false);
            makePrimary.reset();
          }}
        />
      ) : null}
    </SidePanel>
  );
}
