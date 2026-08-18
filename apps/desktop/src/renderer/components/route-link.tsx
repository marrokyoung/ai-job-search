import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from "react";
import { navigate } from "../router.ts";

type RouteLinkProps = {
  href: string;
  children: ReactNode;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "onClick">;

/**
 * An in-app hash link. Navigation goes through the router's `navigate` so the
 * route store updates synchronously; the real href keeps links focusable,
 * announceable, and middle-click-inert under the window-open deny handler.
 */
export function RouteLink({ href, children, ...anchorProps }: RouteLinkProps) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    navigate(href);
  };
  return (
    <a href={href} onClick={onClick} {...anchorProps}>
      {children}
    </a>
  );
}
