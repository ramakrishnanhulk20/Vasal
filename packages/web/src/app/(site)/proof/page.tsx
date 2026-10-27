import type { Metadata } from "next";
import { CheckOurWork } from "@/components/proof/CheckOurWork";
import { Limits } from "@/components/proof/Limits";
import { LeftOut } from "@/components/proof/LeftOut";
import { Names } from "@/components/proof/Names";
import { ProofHeader } from "@/components/proof/ProofHeader";
import { ShowByShow } from "@/components/proof/ShowByShow";
import { Signature } from "@/components/proof/Signature";
import { TwoTests } from "@/components/proof/TwoTests";
import { RunShell } from "@/components/run/RunShell";
import { backtest } from "@/lib/backtest";

export const metadata: Metadata = {
  title: "Proof | Vasal",
  description: `A pre-registered test across ${backtest.sample.episodes} episodes from ${backtest.sample.shows} large podcasts: guests with a higher Qloo fit drew more views, a small but steady link.`,
};

export default function ProofPage() {
  return (
    <RunShell>
      <ProofHeader />
      <Signature />
      <TwoTests />
      <ShowByShow />
      <LeftOut />
      <Names />
      <Limits />
      <CheckOurWork />
    </RunShell>
  );
}
