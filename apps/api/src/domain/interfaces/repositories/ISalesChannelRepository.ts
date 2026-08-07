import { SalesChannel } from "@api/domain/entities/SalesChannel";

export interface ISalesChannelRepository {
  findById(channelId: string): Promise<SalesChannel | null>;
  save(channel: SalesChannel): Promise<void>;
}
