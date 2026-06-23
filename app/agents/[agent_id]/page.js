import { cookies } from "next/headers";
import AgentChatClient from "./AgentChatClient";

export async function generateMetadata({ params }) {
  return { title: `Agent Chat — Open Generative AI` };
}

const BASE_URL = 'https://api.muapi.ai';

async function fetchAgentDetails(agentId, apiKey) {
  if (!apiKey) return null;
  try {
    const res = await fetch(`${BASE_URL}/agents/by-slug/${agentId}`, { cache: "no-store", headers: { "x-api-key": apiKey } });
    if (res.ok) return await res.json();
    if (agentId.length > 20) {
      const resId = await fetch(`${BASE_URL}/agents/${agentId}`, { cache: "no-store", headers: { "x-api-key": apiKey } });
      if (resId.ok) return await resId.json();
    }
    return null;
  } catch (error) {
    console.error("[AgentPage] Fetch error:", error);
    return null;
  }
}

async function fetchUserData(apiKey) {
  if (!apiKey) return null;
  try {
    const res = await fetch(`${BASE_URL}/api/v1/account/balance`, { cache: "no-store", headers: { "x-api-key": apiKey } });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export default async function AgentPage({ params }) {
  const { agent_id } = await params;
  const cookieStore = await cookies();
  const apiKey = cookieStore.get("muapi_key")?.value;
  const [agentDetails, userData] = await Promise.all([fetchAgentDetails(agent_id, apiKey), fetchUserData(apiKey)]);
  return <AgentChatClient agentDetails={agentDetails} initialHistory={null} userData={userData} />;
}
