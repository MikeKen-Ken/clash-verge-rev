import ArticleRoundedIcon from "@mui/icons-material/ArticleRounded";
import BuildRoundedIcon from "@mui/icons-material/BuildRounded";
import LayersRoundedIcon from "@mui/icons-material/LayersRounded";
import PublicRoundedIcon from "@mui/icons-material/PublicRounded";
import VpnKeyRoundedIcon from "@mui/icons-material/VpnKeyRounded";
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
    icon: [<VpnKeyRoundedIcon key="mui" />, <ProxiesSvg key="svg" />],
    Component: ProxiesPage,
  },
  {
    label: "layout.components.navigation.tabs.profiles",
    path: "/profile",
    icon: [<LayersRoundedIcon key="mui" />, <ProfilesSvg key="svg" />],
    Component: ProfilesPage,
  },
  {
    label: "layout.components.navigation.tabs.connections",
    path: "/connections",
    icon: [<PublicRoundedIcon key="mui" />, <ConnectionsSvg key="svg" />],
    Component: ConnectionsPage,
  },
  {
    label: "layout.components.navigation.tabs.logs",
    path: "/logs",
    icon: [<ArticleRoundedIcon key="mui" />, <LogsSvg key="svg" />],
    Component: LogsPage,
  },
  {
    label: "layout.components.navigation.tabs.settings",
    path: "/settings",
    icon: [<BuildRoundedIcon key="mui" />, <SettingsSvg key="svg" />],
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
