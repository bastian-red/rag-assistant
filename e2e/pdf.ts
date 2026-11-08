/**
 * The E2E lane's PDF, built in code by the same generator the ingest suite
 * uses, so no binary fixture lives in the repo.
 */
import { makePdf } from '../services/ingest/test/pdf';

/**
 * Two pages, so a citation can land on the second: the radiator sentence is
 * on page 2 and nowhere else.
 */
export const BOILER_PAGES = [
  'Boiler care guide\nThe pressure gauge should read between 1 and 1.5 bar when the boiler is cold.',
  'Bleed the radiators every autumn with a radiator key.\nKeep the radiator key in the kitchen drawer.',
] as const;

export const RADIATOR_SENTENCE = 'Bleed the radiators every autumn with a radiator key.';

export function boilerPdf(): Buffer {
  return makePdf(BOILER_PAGES);
}

/** A `.pdf` that is not a PDF: the API refuses it by its magic bytes. */
export function fakePdf(): Buffer {
  return Buffer.from('This is plain text wearing a .pdf name.\n', 'utf8');
}
