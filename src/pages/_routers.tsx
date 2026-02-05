import DnsRoundedIcon from "@mui/icons-material/DnsRounded";
import LanguageRoundedIcon from "@mui/icons-material/LanguageRounded";
import SettingsRoundedIcon from "@mui/icons-material/SettingsRounded";
import SubjectRoundedIcon from "@mui/icons-material/SubjectRounded";
import WifiRoundedIcon from "@mui/icons-material/WifiRounded";
import { createBrowserRouter, Navigate, RouteObject } from "react-router";

import ConnectionsSvg from "@/assets/image/itemicon/connections.svg?react";
import LogsSvg from "@/assets/image/itemicon/logs.svg?react";
import ProfilesSvg from "@/assets/image/itemicon/profiles.svg?react";
import ProxiesSvg from "@/assets/image/itemicon/proxies.svg?react";
import SettingsSvg from "@/assets/image/itemicon/settings.svg?react";

import Layout from "./_layout";
import ConnectionsPage from "./connections";
import LogsPage from "./logs";
import ProfilesPage from "./profiles";
import ProxiesPage from "./proxies";
import SettingsPage from "./settings";

export const navItems = [
  {
    label: "layout.components.navigation.tabs.proxies",
    path: "/proxies",
    icon: [<WifiRoundedIcon key="mui" />, <ProxiesSvg key="svg" />],
    Component: ProxiesPage,
  },
  {
    label: "layout.components.navigation.tabs.profiles",
    path: "/profile",
    icon: [<DnsRoundedIcon key="mui" />, <ProfilesSvg key="svg" />],
    Component: ProfilesPage,
  },
  {
    label: "layout.components.navigation.tabs.connections",
    path: "/connections",
    icon: [<LanguageRoundedIcon key="mui" />, <ConnectionsSvg key="svg" />],
    Component: ConnectionsPage,
  },
  {
    label: "layout.components.navigation.tabs.logs",
    path: "/logs",
    icon: [<SubjectRoundedIcon key="mui" />, <LogsSvg key="svg" />],
    Component: LogsPage,
  },
  {
    label: "layout.components.navigation.tabs.settings",
    path: "/settings",
    icon: [<SettingsRoundedIcon key="mui" />, <SettingsSvg key="svg" />],
    Component: SettingsPage,
  },
];

export const router = createBrowserRouter([
  {
    path: "/",
    Component: Layout,
    children: [
      { index: true, element: <Navigate to="/proxies" replace /> },
      ...navItems.map(
        (item) =>
          ({
            path: item.path,
            Component: item.Component,
          }) as RouteObject,
      ),
    ],
  },
]);
