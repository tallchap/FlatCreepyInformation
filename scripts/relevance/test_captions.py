import hashlib
import unittest

import audit
from captions import caption_context, parse_captions
from process_astra import validate


class CaptionTests(unittest.TestCase):
    def test_multiline_and_end_exclusive_validation(self):
        text = '[0] >>John: AI can\nreplicate itself.\n[10] Keep the hedge:\nperhaps, not certainly.\n[20] Next topic\nnot retained.'
        source = {'video_id': 'abcdefghijk', 'transcript': text}
        source['input_hash'] = audit.digest(source)
        packet = dict(candidate_id=source['video_id'], lane='review', source_input_hash=source['input_hash'],
                      full_transcript_sha256=hashlib.sha256(text.encode()).hexdigest(), source_duration_seconds=30,
                      context_start_seconds=0, context_end_seconds=30,
                      luna_proposal=dict(start_seconds=0, end_seconds=20),
                      gcs_object=dict(bucket='test', name='videos/abcdefghijk.mp4', generation='1', size='100'))
        recipe = dict(schema_version='snippy-astra-edit-v1', candidate_id=source['video_id'],
                      source_input_hash=source['input_hash'], decision='approve', clip_worthy=True,
                      title='Title', speaker='John', reason='Reason', edit_notes='',
                      edits=[dict(start_seconds=0, end_seconds=20,
                                  transcript='>>John: AI can replicate itself. Keep the hedge: perhaps, not certainly.')])
        self.assertTrue(validate(recipe, packet, source, set())['renderable'])
        for bad in ['>>John: AI can Keep the hedge:',
                    recipe['edits'][0]['transcript'] + ' Next topic not retained.']:
            recipe['edits'][0]['transcript'] = bad
            with self.assertRaisesRegex(ValueError, 'ALL verbatim'):
                validate(recipe, packet, source, set())
        self.assertEqual(source['transcript'], text)

    def test_context_selects_whole_records_then_roundtrips(self):
        text = '[1.25] outside\nnot included\n[10] first\ncontinuation\n[20.5] final\n[Laughter]\n>>Speaker: last line\n[30] excluded\nits continuation'
        context = caption_context(text, 10, 20.5)
        self.assertEqual(context, '[10] first continuation\n[20.5] final [Laughter] >>Speaker: last line')
        self.assertEqual(parse_captions(context), [(10, 'first continuation'), (20.5, 'final [Laughter] >>Speaker: last line')])

    def test_legacy_duplicate_timestamps_whitespace_and_precision(self):
        self.assertEqual(parse_captions('\n[0] first\n\n[0] second\r\n[5649.639]  two  spaces\nlast'),
                         [(0, 'first'), (0, 'second'), (5649.639, ' two  spaces last')])
        self.assertEqual(caption_context('[5649.639] exact', 0, 6000), '[5649.639] exact')
        self.assertEqual(parse_captions('[0]\ntext'), [(0, 'text')])
        self.assertEqual(parse_captions(''), [])
        self.assertEqual(parse_captions('[0] speech\n[UNKNOWN].\n[4K] video'),
                         [(0, 'speech [UNKNOWN]. [4K] video')])

    def test_malformed_timestamp_and_orphan_text_fail_closed(self):
        for text in ['orphan\n[0] text', '[0] okay\n[unknown] bad', '[0] okay\n[1.2.3] bad',
                     '[-1] negative', '[nan] nope', '[20] later\n[10] earlier']:
            with self.subTest(text=text), self.assertRaises(ValueError):
                parse_captions(text)


if __name__ == '__main__':
    unittest.main()
