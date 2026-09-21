import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { EnvironmentNotice, type EnvironmentView } from '../src/components/EnvironmentNotice';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it.each([
  ['dev', 'dev', false],
  ['staging', 'staging', false],
  ['prod', 'prod', false],
  ['dev', 'prod', true],
  ['unknown', 'prod', false],
  ['dev', 'unknown', false],
] as const)('shows %s and %s, mismatch %s', async (local, remote, mismatch) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            environmentName: local,
            officePulse: {
              reachable: true,
              environmentName: remote,
              pbxInstanceId: 'officepulse-prod',
            },
            mismatch,
          }),
        ),
    ),
  );
  render(<EnvironmentNotice />);
  expect(await screen.findByText(`OfficePulse: ${remote}`, { exact: false })).toHaveTextContent(
    `Environment: ${local}`,
  );
  if (mismatch) {
    expect(screen.getByRole('alert')).toHaveTextContent(
      'AidaAdmin is dev, but OfficePulse is prod (PBX officepulse-prod)',
    );
  } else expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
it('refreshes across mismatch, unreachability and recovery without a stale warning', async () => {
  vi.useFakeTimers();
  let state: EnvironmentView = {
    environmentName: 'dev',
    officePulse: { reachable: true, environmentName: 'prod', pbxInstanceId: 'officepulse-prod' },
    mismatch: true,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(state))),
  );
  await act(async () => {
    render(<EnvironmentNotice />);
  });
  expect(screen.getByRole('alert')).toHaveTextContent('officepulse-prod');
  state = {
    ...state,
    mismatch: false,
    officePulse: { ...state.officePulse, reachable: false, environmentName: 'unknown' },
  };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000);
  });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByText(/Environment:/)).toHaveTextContent(
    'Environment: dev · OfficePulse: unavailable',
  );
  state = {
    ...state,
    officePulse: { ...state.officePulse, reachable: true, environmentName: 'dev' },
  };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000);
  });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByText(/Environment:/)).toHaveTextContent('OfficePulse: dev');
});
