// The supervisor console's Compliance tab (2026-09-27): period-based evidence that visits were
// delivered and verified, how exceptions were handled, how quickly missed-visit alerts were
// answered, who consented to what, who accepted the terms, and who did what (the audit trail) -
// the six v1 sections docs/compliance-research.md recommended, each exportable as CSV. It is
// deliberately separate from the Overview, which is about today's live operations.
//
// The tab, month and each report's filters live in the URL, so a reload or a shared link shows
// the same report. Reports are monthly because that's how they're exported and filed.

import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ChartColumnIcon,
  Download04Icon,
  Table01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useMutation } from '@tanstack/react-query';
import type { ExportReport } from '../api/compliance';
import { useApi } from '../api/useApi';
import { useAuth } from '../auth/AuthContext';
import { AlertsReport } from '../components/compliance/AlertsReport';
import { AuditLogReport } from '../components/compliance/AuditLogReport';
import { CaregiverPerformanceReport } from '../components/compliance/CaregiverPerformanceReport';
import { ConsentReport } from '../components/compliance/ConsentReport';
import { ExceptionsReport } from '../components/compliance/ExceptionsReport';
import {
  currentMonth,
  monthLabel,
  monthPeriod,
  parseMonth,
  recentMonths,
  shiftMonth,
} from '../components/compliance/period';
import { TermsReport } from '../components/compliance/TermsReport';
import { VisitsReport } from '../components/compliance/VisitsReport';
import { Button } from '../design-system/Button';
import { SegmentedControl } from '../design-system/SegmentedControl';
import { useListParams } from '../hooks/useListParams';
import './CompliancePage.css';

const TABS = [
  { id: 'visits', label: 'Visit verification' },
  { id: 'performance', label: 'Caregiver performance' },
  { id: 'exceptions', label: 'Exceptions' },
  { id: 'alerts', label: 'Alert response' },
  { id: 'consent', label: 'Consent' },
  { id: 'terms', label: 'Terms' },
  { id: 'audit', label: 'Audit log' },
] as const;
type TabId = (typeof TABS)[number]['id'];

// Consent and terms are the current state, not a period, so they have no month.
const PERIOD_TABS: readonly TabId[] = ['visits', 'performance', 'exceptions', 'alerts', 'audit'];

const EXPORTS: Record<TabId, { report: ExportReport; label: string }[]> = {
  visits: [
    { report: 'visit-summary', label: 'Export summary' },
    { report: 'visits', label: 'Export all visits' },
  ],
  performance: [{ report: 'caregiver-performance', label: 'Export report' }],
  // The all-visits export carries each exception and its resolution.
  exceptions: [{ report: 'visits', label: 'Export all visits' }],
  alerts: [],
  consent: [{ report: 'consents', label: 'Export register' }],
  terms: [{ report: 'terms', label: 'Export acceptances' }],
  audit: [{ report: 'audit-log', label: 'Export log' }],
};

// Every tab's filter keys, cleared when switching tabs so one report's filters never leak into
// another's URL.
const FILTER_KEYS = [
  'groupBy',
  'sort',
  'kind',
  'resolved',
  'subjectType',
  'status',
  'action',
  'entityType',
  'view',
];

export function CompliancePage() {
  const { identity } = useAuth();
  const { compliance } = useApi();
  const params = useListParams();
  const tab = params.oneOf(
    'tab',
    TABS.map((t) => t.id),
    'visits',
  );
  const month = parseMonth(params.get('month'));
  const period = monthPeriod(month);
  const hasPeriod = PERIOD_TABS.includes(tab);
  // Caregiver performance's table or charts, kept in the URL like every other report setting.
  const performanceView = params.oneOf('view', ['table', 'charts'] as const, 'table');

  const exportMutation = useMutation({
    mutationFn: (report: ExportReport) =>
      compliance.exportReport(report, {
        ...(report === 'consents' || report === 'terms' ? {} : period),
        groupBy:
          report === 'visit-summary'
            ? params.oneOf('groupBy', ['caregiver', 'dependant'] as const, 'caregiver')
            : undefined,
        action: report === 'audit-log' ? params.get('action') || undefined : undefined,
        entityType: report === 'audit-log' ? params.get('entityType') || undefined : undefined,
      }),
  });

  if (identity?.role !== 'supervisor') {
    return <p className="compliance__message">Compliance reports are for supervisors only.</p>;
  }

  const months = recentMonths();
  return (
    <div className="compliance">
      <SegmentedControl
        appearance="tabs"
        label="Compliance reports"
        idPrefix="compliance"
        segments={TABS.map((t) => ({ id: t.id, label: t.label }))}
        selected={tab}
        onChange={(id) => {
          exportMutation.reset();
          params.clear([...FILTER_KEYS, 'visit']);
          params.set('tab', id === 'visits' ? '' : id);
        }}
      />

      <div className="compliance__toolbar">
        {hasPeriod ? (
          <div className="compliance__period">
            <Button
              type="button"
              aria-label="Previous month"
              disabled={month === months.at(-1)}
              onClick={() => params.set('month', shiftMonth(month, -1))}
            >
              <HugeiconsIcon icon={ArrowLeft01Icon} size={16} strokeWidth={1.5} aria-hidden />
            </Button>
            <select
              className="compliance__month"
              aria-label="Month to report on"
              value={month}
              onChange={(event) =>
                params.set('month', event.target.value === currentMonth() ? '' : event.target.value)
              }
            >
              {months.map((m) => (
                <option key={m} value={m}>
                  {monthLabel(m)}
                </option>
              ))}
            </select>
            <Button
              type="button"
              aria-label="Next month"
              disabled={month === currentMonth()}
              onClick={() => {
                const next = shiftMonth(month, 1);
                params.set('month', next === currentMonth() ? '' : next);
              }}
            >
              <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={1.5} aria-hidden />
            </Button>
          </div>
        ) : (
          <p className="compliance__as-of">As of now</p>
        )}

        <div className="compliance__exports">
          {tab === 'performance' ? (
            <Button
              type="button"
              aria-pressed={performanceView === 'charts'}
              onClick={() => params.set('view', performanceView === 'charts' ? '' : 'charts')}
            >
              <HugeiconsIcon
                icon={performanceView === 'charts' ? Table01Icon : ChartColumnIcon}
                size={16}
                strokeWidth={1.5}
                aria-hidden
              />
              {performanceView === 'charts' ? 'Show table' : 'Show charts'}
            </Button>
          ) : null}
          {EXPORTS[tab].map(({ report, label }) => (
            <Button
              key={report}
              type="button"
              disabled={exportMutation.isPending}
              onClick={() => exportMutation.mutate(report)}
            >
              <HugeiconsIcon icon={Download04Icon} size={16} strokeWidth={1.5} aria-hidden />
              {exportMutation.isPending && exportMutation.variables === report
                ? 'Exporting...'
                : label}
            </Button>
          ))}
        </div>
      </div>

      <div
        id={`compliance-${tab}`}
        role="tabpanel"
        aria-labelledby={`compliance-tab-${tab}`}
        className="compliance__panel"
      >
        {tab === 'visits' ? <VisitsReport period={period} /> : null}
        {tab === 'performance' ? (
          <CaregiverPerformanceReport period={period} view={performanceView} />
        ) : null}
        {tab === 'exceptions' ? <ExceptionsReport period={period} /> : null}
        {tab === 'alerts' ? <AlertsReport period={period} /> : null}
        {tab === 'consent' ? <ConsentReport /> : null}
        {tab === 'terms' ? <TermsReport /> : null}
        {tab === 'audit' ? <AuditLogReport period={period} /> : null}
      </div>
    </div>
  );
}
