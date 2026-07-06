import { prisma } from "@/lib/db/prisma";
import { decrypt, getOrCreateMasterKey, isEncrypted } from "@/lib/auth/encrypt";
import AISettingsClient, { type InitialAiChannel } from "./client";

export const dynamic = "force-dynamic";

async function loadInitialAiConfig(): Promise<{
  channels: InitialAiChannel[];
  activeModelId: string | null;
}> {
  const [channels, activeModel] = await Promise.all([
    prisma.aiChannel.findMany({
      orderBy: { createdAt: "asc" },
      include: { AiModel: { orderBy: { createdAt: "asc" } } },
    }),
    prisma.aiModel.findFirst({ where: { active: true }, select: { id: true } }),
  ]);

  const masterKey = await getOrCreateMasterKey();
  return {
    activeModelId: activeModel?.id ?? null,
    channels: channels.map((channel) => ({
      id: channel.id,
      name: channel.name,
      channelType: channel.channelType,
      baseUrl: channel.baseUrl,
      apiKey: channel.apiKey && isEncrypted(channel.apiKey) ? decrypt(channel.apiKey, masterKey) : channel.apiKey ?? "",
      AiModel: channel.AiModel.map((model) => ({
        id: model.id,
        name: model.name,
        model: model.model,
        vision: model.vision,
        active: model.active,
      })),
    })),
  };
}

export default async function AISettingsPage() {
  const initial = await loadInitialAiConfig().catch(() => ({ channels: [], activeModelId: null }));

  return (
    <AISettingsClient
      initialChannels={initial.channels}
      initialActiveModelId={initial.activeModelId}
    />
  );
}
