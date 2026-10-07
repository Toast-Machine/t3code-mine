import { createFileRoute } from "@tanstack/react-router";

import { UsagePage } from "../components/usage/UsagePage";
import { METRIC_OPTIONS, type UsageMetric } from "../components/usage/usageShortcuts";

export interface UsageSearch {
  /** Selected view. Absent falls back to the saved preference. */
  readonly metric?: UsageMetric;
}

export const Route = createFileRoute("/usage")({
  validateSearch: (raw: Record<string, unknown>): UsageSearch =>
    METRIC_OPTIONS.some((option) => option.value === raw.metric)
      ? { metric: raw.metric as UsageMetric }
      : {},
  component: UsageRoute,
});

// The view lives in the URL so the Usage sidebar and the page share it; the
// sidebar is the view switcher here, so the page hides its own.
function UsageRoute() {
  const { metric } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <UsagePage
      {...(metric ? { metric } : {})}
      onMetricChange={(next) => void navigate({ search: { metric: next } })}
      showMetricSwitcher={false}
    />
  );
}
