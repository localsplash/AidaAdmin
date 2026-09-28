import { render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ObservationAvailability } from '../src/components/ObservationAvailability';
import { runtimeApi } from '../src/api/runtime';
afterEach(() => vi.restoreAllMocks());
it('keeps transcription visible with exact unavailable prerequisites', async () => {
  vi.spyOn(runtimeApi, 'observationStatus').mockResolvedValue({
    observerConfigured: false,
    admissionReady: false,
    livekitReady: false,
  });
  render(<ObservationAvailability />);
  expect(screen.getByRole('heading', { name: 'Live transcription' })).toBeInTheDocument();
  await screen.findByText(/LiveKit observation has not been configured/);
  expect(screen.getByText(/Telephone-to-Aida routing is unavailable/)).toBeInTheDocument();
  expect(screen.getByText('The LiveKit voice connection is unavailable.')).toBeInTheDocument();
  expect(screen.getByText(/If there are no active calls/)).toBeInTheDocument();
});
it('distinguishes failed diagnostics from no active calls and removes stale status', async () => {
  vi.spyOn(runtimeApi, 'observationStatus').mockRejectedValue(new Error('offline'));
  render(<ObservationAvailability />);
  await screen.findByText(/Transcription availability could not be checked/);
  expect(within(screen.getByRole('status')).queryByText(/configured/)).toBeNull();
});
it('shows configured observation without claiming actual speech or admission when unknown', async () => {
  vi.spyOn(runtimeApi, 'observationStatus').mockResolvedValue({
    observerConfigured: true,
    admissionReady: null,
    livekitReady: null,
  });
  render(<ObservationAvailability />);
  await screen.findByText('Transcript observation is configured.');
  expect(screen.getByText(/Telephone call readiness could not be verified/)).toBeInTheDocument();
});
