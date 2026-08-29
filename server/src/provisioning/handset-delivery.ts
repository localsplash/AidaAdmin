/**
 * Delivery of one-time handset enrollment material to the existing HTTPS
 * provisioning service (the Grandstream MAC-address provisioning record).
 * The plaintext enrollment token flows only through this call; AidaAdmin
 * stores its hash and AidaControl consumes it at enrollment.
 *
 * The existing service's API is deployment configuration
 * (HANDSET_PROVISIONING_URL); the POC payload is the documented value set
 * from the specification §2.7: deviceId, normalized MAC, and the one-time
 * token with its expiry.
 */

export interface HandsetEnrollmentDelivery {
  deviceId: string;
  provisioningMac: string;
  enrollmentToken: string;
  expiresAt: string;
}

export interface HandsetProvisioningDelivery {
  deliver(payload: HandsetEnrollmentDelivery): Promise<void>;
}

export class HandsetDeliveryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export class HttpHandsetProvisioningDelivery implements HandsetProvisioningDelivery {
  constructor(private readonly url: string) {}

  async deliver(payload: HandsetEnrollmentDelivery): Promise<void> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new HandsetDeliveryError('Handset provisioning delivery failed', res.status);
    }
  }
}
