import { Box } from "@mui/material";
import { useEffect, useState } from "react";

import {
  effectiveDelayMsFor,
  subscribeConnectivityStats,
} from "@/services/proxy-connectivity-stats";

export function EffectiveDelayLabel({ proxyName }: { proxyName: string }) {
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
        color: "#000",
      }}
    >
      {ms}
    </Box>
  );
}
