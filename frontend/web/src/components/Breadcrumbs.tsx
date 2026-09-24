import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';
import { useApi } from '../api/useApi';
import './Breadcrumbs.css';

// Hand-written against this app's own known, small route set (App.tsx) rather than a generic
// route-config-driven matcher - concrete over abstract for a handful of routes, matching this
// codebase's own general preference elsewhere. Reads `location.pathname` directly rather than
// react-router's `useParams()`, since this component is rendered by AppShell as a sibling wrapping
// <Routes>, outside any individual <Route>'s own param scope.

interface Crumb {
  label: string;
  to?: string;
}

function buildCrumbs(
  segments: string[],
  names: { dependantName?: string; caregiverName?: string; visitLabel?: string },
): Crumb[] {
  const [root, second, third] = segments;

  if (root === 'dependants') {
    const crumbs: Crumb[] = [
      { label: 'Dependants', to: segments.length > 1 ? '/dependants' : undefined },
    ];
    if (second === 'new') {
      crumbs.push({ label: 'New Dependant' });
    } else if (second) {
      const name = names.dependantName ?? 'Dependant';
      if (!third) {
        crumbs.push({ label: name });
      } else if (third === 'edit') {
        crumbs.push({ label: name, to: `/dependants/${second}` }, { label: 'Edit' });
      } else if (third === 'care-plan') {
        crumbs.push({ label: name, to: `/dependants/${second}` }, { label: 'Care Plan' });
      }
    }
    return crumbs;
  }

  if (root === 'caregivers') {
    const crumbs: Crumb[] = [
      { label: 'Caregivers', to: segments.length > 1 ? '/caregivers' : undefined },
    ];
    if (second === 'new') {
      crumbs.push({ label: 'New Caregiver' });
    } else if (second) {
      const name = names.caregiverName ?? 'Caregiver';
      if (!third) {
        crumbs.push({ label: name });
      } else if (third === 'edit') {
        crumbs.push({ label: name, to: `/caregivers/${second}` }, { label: 'Edit' });
      }
    }
    return crumbs;
  }

  if (root === 'visits') {
    const crumbs: Crumb[] = [{ label: 'Visits', to: segments.length > 1 ? '/visits' : undefined }];
    if (second) {
      crumbs.push({ label: names.visitLabel ?? 'Visit' });
    }
    return crumbs;
  }
  if (root === 'flagged-enrollments') {
    return [{ label: 'Flagged Enrollments' }];
  }

  return [];
}

export function Breadcrumbs() {
  const location = useLocation();
  const { dependants, caregivers, visitSchedules } = useApi();
  const segments = location.pathname.split('/').filter(Boolean);

  const dependantId =
    segments[0] === 'dependants' && segments[1] && segments[1] !== 'new' ? segments[1] : undefined;
  const caregiverId =
    segments[0] === 'caregivers' && segments[1] && segments[1] !== 'new' ? segments[1] : undefined;
  const visitId = segments[0] === 'visits' && segments[1] ? segments[1] : undefined;

  // Same queryKey the detail pages themselves use - a cache hit there, not a duplicate fetch, on
  // the common path of navigating detail -> edit/care-plan without a full page reload in between.
  const dependantQuery = useQuery({
    queryKey: ['dependant', dependantId],
    queryFn: () => dependants.getDependant(dependantId!),
    enabled: Boolean(dependantId),
  });
  const caregiverQuery = useQuery({
    queryKey: ['caregiver', caregiverId],
    queryFn: () => caregivers.getCaregiver(caregiverId!),
    enabled: Boolean(caregiverId),
  });
  const visitQuery = useQuery({
    queryKey: ['visit-schedule', visitId],
    queryFn: () => visitSchedules.getVisitSchedule(visitId!),
    enabled: Boolean(visitId),
  });

  const crumbs = buildCrumbs(segments, {
    dependantName: dependantQuery.data?.fullName,
    caregiverName: caregiverQuery.data?.fullName,
    visitLabel: visitQuery.data
      ? `${visitQuery.data.caregiverDisplayName} → ${visitQuery.data.dependantDisplayName}`
      : undefined,
  });

  // A single top-level crumb (e.g. plain "/visits") adds no navigational value over the
  // page's own title/the already-active sidebar item - only render once there's real nesting.
  if (crumbs.length <= 1) {
    return null;
  }

  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      {crumbs.map((crumb, index) => (
        <span key={index} className="breadcrumbs__item">
          {crumb.to ? (
            <Link to={crumb.to} className="breadcrumbs__link">
              {crumb.label}
            </Link>
          ) : (
            <span className="breadcrumbs__current">{crumb.label}</span>
          )}
          {index < crumbs.length - 1 ? <span className="breadcrumbs__separator">/</span> : null}
        </span>
      ))}
    </nav>
  );
}
