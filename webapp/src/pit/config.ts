/** The Pit runtime config — set VITE_PIT_* at build time (.env.local or Railway variables). */
import { GATE_URL } from "../lib/config";

/** The launchpad factory (e.g. pit.yourname.testnet). */
export const PIT_FACTORY = (import.meta.env.VITE_PIT_FACTORY as string) || "";
/** A single coin, for deployments without the launchpad. */
export const PIT_CONTRACT = (import.meta.env.VITE_PIT_CONTRACT as string) || "";
export const PIT_GATE_URL = (import.meta.env.VITE_PIT_GATE_URL as string) || GATE_URL;
/** The brain service's base URL; its /api/feed powers "recent activity". */
export const PIT_BRAIN_URL = (import.meta.env.VITE_PIT_BRAIN_URL as string) || "";
/** Neither configured → preview mode with sample data and a clear banner. */
export const PREVIEW = !PIT_FACTORY && !PIT_CONTRACT;
