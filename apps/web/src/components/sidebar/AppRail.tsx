import { ChartNoAxesColumnIcon, MessagesSquareIcon, SettingsIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { cn } from "../../lib/utils";
import { useEnvironments } from "../../state/environments";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useNavigateToMainApp } from "./mainAppLocation";
import { SidebarPaletteMenuButton } from "./SidebarChrome";

// Slack-style app rail (my-tweaks trial): one icon per page of the app, left of
// the thread sidebar. Threads is home; Pull requests, Usage, and Settings are
// separate pages rather than footer buttons.
function RailButton(props: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={props.label}
            aria-current={props.active ? "page" : undefined}
            onClick={props.onClick}
            className={cn(
              "flex size-10 cursor-pointer items-center justify-center rounded-xl text-sidebar-muted-foreground outline-none hover:bg-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-[18px]",
              props.active && "bg-row-active text-sidebar-foreground hover:bg-row-active",
            )}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="right">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

export function AppRail() {
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { environments } = useEnvironments();
  const pullRequestsSupported = environments.some(
    (environment) => environment.serverConfig?.environment.capabilities.pullRequests === true,
  );
  const page = pathname.startsWith("/settings")
    ? "settings"
    : pathname.startsWith("/usage")
      ? "usage"
      : pathname.startsWith("/pull-requests")
        ? "pull-requests"
        : "threads";
  return (
    <nav
      aria-label="App"
      data-app-sidebar=""
      data-app-rail=""
      className="relative z-20 hidden h-dvh w-(--app-rail-width) shrink-0 flex-col items-center gap-1.5 pt-16 pb-3 md:flex"
    >
      <RailButton
        label="Threads"
        active={page === "threads"}
        onClick={() => void navigateToMainApp()}
      >
        <MessagesSquareIcon />
      </RailButton>
      {pullRequestsSupported ? (
        <RailButton
          label="Pull requests"
          active={page === "pull-requests"}
          onClick={() =>
            void navigate({ to: "/pull-requests", search: readPullRequestListPreferences() })
          }
        >
          <PullRequestGlyph.pullRequest />
        </RailButton>
      ) : null}
      <RailButton
        label="Usage"
        active={page === "usage"}
        onClick={() => void navigate({ to: "/usage" })}
      >
        <ChartNoAxesColumnIcon />
      </RailButton>
      <div className="flex-1" />
      <SidebarPaletteMenuButton />
      <RailButton
        label="Settings"
        active={page === "settings"}
        onClick={() => void navigate({ to: "/settings" })}
      >
        <SettingsIcon />
      </RailButton>
    </nav>
  );
}
