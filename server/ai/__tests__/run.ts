// Entry point for `npm test`.
//
// Windows cmd/npm does not expand globs, so we import every test module here and
// hand this single file to `tsx --test`. node:test registers each imported test
// with the same runner.
import './adapters.test';
import './settings.test';
import './schema.test';
import './fallback.test';
import './store.test';
import './pageSettings.test';
import './prompt.test';
import './countries.test';
import './builtins.test';
import './templates.test';
import './createTemplate.test';
import './ingestion.test';
import './pdfExport.test';
