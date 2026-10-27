import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { NavTitle } from "@/components/docs/NavTitle";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: { title: <NavTitle />, url: "/" },
    links: [
      { text: "Proof", url: "/proof" },
      { text: "For agents", url: "/agents" },
    ],
    githubUrl: "https://github.com/ramakrishnanhulk20/Vasal",
    themeSwitch: { enabled: false },
  };
}
