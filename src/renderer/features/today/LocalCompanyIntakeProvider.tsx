import type { ReactNode } from 'react';
import { LocalCompanyIntakeProvider as Provider, type IntakeApi } from './LocalCompanyIntake';

export function LocalCompanyIntakeProvider({ api, children }: { api?: IntakeApi; children: ReactNode }) {
  return <Provider api={api}>{children}</Provider>;
}
