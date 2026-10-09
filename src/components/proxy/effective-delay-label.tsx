import { Box } from "@mui/material";
import { useEffect, useState } from "react";

import {
  effectiveDelayMsFor,
  subscribeConnectivityStats,
} from "@/services/proxy-connectivity-stats";

interface Props {
  proxyName: string;
  selected: boolean;
}

export function EffectiveDelayLabel({ proxyName, selected }: Props) {
  const [ms, setMs] = useState<number | null>(() =>
    effectiveDelayMsFor(proxyName),
  );

  useEffect(() => {
    const refresh = () => setMs(effectiveDelayMsFor(proxyName));
    refresh();
    return subscribeConnectivityStats(refresh);
  }, [proxyName]);

  if (ms == null) return null;

  return (
    <Box
      component="span"
      sx={{
        display: "block",
        fontSize: 10,
        lineHeight: 1.1,
        textAlign: "right",
        fontWeight: 600,
        color: selected ? "rgba(255, 255, 255, 0.72)" : "rgba(0, 0, 0, 0.62)",
      }}
    >
      {ms}
    </Box>
  );
}
