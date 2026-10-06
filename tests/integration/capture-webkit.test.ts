import { browserCaptureProof } from './capture-browser-proof.ts'
process.env['RETEST_TEST_ENGINE'] = 'webkit'
browserCaptureProof('webkit', 'screencast')
