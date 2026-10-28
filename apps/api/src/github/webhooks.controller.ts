import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Post,
  RawBodyRequest,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { API_CONFIG, ApiConfig, githubSettings } from "../config";
import { WebhookOutcome, WebhookService } from "./webhook.service";
import { verifyWebhookSignature } from "./webhook-signature";

@Controller("github/webhooks")
export class WebhooksController {
  private readonly secret: string | null;

  constructor(
    @Inject(API_CONFIG) config: ApiConfig,
    private readonly webhooks: WebhookService,
  ) {
    this.secret = githubSettings(config)?.webhookSecret ?? null;
  }

  @Post()
  @HttpCode(200)
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers("x-github-event") event: string | undefined,
    @Headers("x-github-delivery") deliveryId: string | undefined,
    @Headers("x-hub-signature-256") signature: string | undefined,
  ): Promise<{ outcome: WebhookOutcome }> {
    if (!this.secret) throw new ServiceUnavailableException("Webhooks are not configured");
    // Verify before reading anything else from the request.
    if (!req.rawBody || !verifyWebhookSignature(this.secret, req.rawBody, signature)) {
      throw new UnauthorizedException("Invalid webhook signature");
    }
    if (!event || !deliveryId || deliveryId.length > 100) {
      throw new BadRequestException("Missing GitHub delivery headers");
    }
    return { outcome: await this.webhooks.process(deliveryId, event, req.body) };
  }
}
