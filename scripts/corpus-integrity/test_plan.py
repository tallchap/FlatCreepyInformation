import unittest

import plan


class Lengths(unittest.TestCase):
    def test_parse_all_stored_shapes(self):
        self.assertEqual(plan.parse_length('1:02:03'), 3723)
        self.assertEqual(plan.parse_length('47:48'), 2868)
        self.assertEqual(plan.parse_length('5160'), 5160)
        self.assertIsNone(plan.parse_length('PT1M'))
        self.assertIsNone(plan.parse_length(None))

    def test_format_matches_app_formatDuration(self):
        self.assertEqual(plan.format_length(2868), '47:48')
        self.assertEqual(plan.format_length(3723), '1:02:03')
        self.assertEqual(plan.format_length(59), '0:59')
        self.assertEqual(plan.format_length(36000), '10:00:00')

    def test_shifted_march_import_is_wrong_but_rounding_is_not(self):
        self.assertTrue(plan.length_wrong('47:48:00', 2868))  # minutes stored as hours
        self.assertFalse(plan.length_wrong('47:48', 2868))
        self.assertFalse(plan.length_wrong('47:50', 2868))  # within 5 s
        self.assertTrue(plan.length_wrong('garbage', 100))
        self.assertFalse(plan.length_wrong('1:00', None))  # unknown truth is never "wrong"


class Speakers(unittest.TestCase):
    def test_split_trims_and_dedupes_accent_insensitively(self):
        self.assertEqual(plan.speakers(' Zoë Ann ,Zoe Ann, Bob,,'), ['Zoë Ann', 'Bob'])
        self.assertEqual(plan.speakers(None), [])

    def test_plan_finds_stale_missing_and_surplus(self):
        files = [{'file_id': 'f1', 'speaker': 'Geoffrey Hinton'}, {'file_id': 'f2', 'speaker': "Paddy O'Connell"},
                 {'file_id': 'f3', 'speaker': 'Geoffrey Hinton'}, {'file_id': 'f4', 'speaker': 'Fei-Fei Li'}]
        stale, missing, extra = plan.speaker_plan('Geoffrey Hinton, Fei-Fei Li, Yalda Hakim', files)
        self.assertEqual(stale, ['f2'])
        self.assertEqual(missing, ['Yalda Hakim'])
        self.assertEqual(extra, ['f3'])

    def test_diacritics_match_the_stored_attribute(self):
        stale, missing, _ = plan.speaker_plan('Álvaro Pérez', [{'file_id': 'f', 'speaker': 'Alvaro Perez'}])
        self.assertEqual((stale, missing), ([], []))


class Duplicates(unittest.TestCase):
    def test_same_recording_needs_containment_both_ways(self):
        self.assertTrue(plan.is_same_recording({'shared': 90, 'na': 100, 'nb': 110}, 600, 610))
        # a 2-minute clip cut from a 1-hour episode: fully contained one way only
        self.assertFalse(plan.is_same_recording({'shared': 20, 'na': 20, 'nb': 600}, 120, 3600))

    def test_length_mismatch_vetoes_even_high_overlap(self):
        self.assertFalse(plan.is_same_recording({'shared': 90, 'na': 100, 'nb': 100}, 600, 900))
        self.assertTrue(plan.is_same_recording({'shared': 90, 'na': 100, 'nb': 100}, None, 900))
        self.assertFalse(plan.is_same_recording({'shared': 0, 'na': 0, 'nb': 10}, 1, 1))

    def test_groups_are_transitive(self):
        self.assertEqual(plan.group_duplicates([('b', 'c'), ('a', 'b'), ('x', 'y')]), [['a', 'b', 'c'], ['x', 'y']])
        self.assertEqual(plan.group_duplicates([]), [])

    def base(self, **kw):
        d = {'user_content': 0, 'bunny': False, 'on_youtube': True, 'published': '2024-01-01', 'segments': 100}
        d.update(kw)
        return d

    def test_survivor_prefers_bunny_then_original(self):
        info = {'a': self.base(published='2023-01-01'), 'b': self.base(bunny=True, published='2025-01-01')}
        self.assertEqual(plan.choose_survivor(['a', 'b'], info), ('b', ['a'], 'has the Bunny copy'))
        info['b']['bunny'] = False
        self.assertEqual(plan.choose_survivor(['a', 'b'], info)[0], 'a')

    def test_user_content_wins_and_two_owners_block(self):
        info = {'a': self.base(bunny=True), 'b': self.base(user_content=2)}
        self.assertEqual(plan.choose_survivor(['a', 'b'], info)[:2], ('b', ['a']))
        info['a']['user_content'] = 1
        self.assertEqual(plan.choose_survivor(['a', 'b'], info)[:2], (None, []))

    def test_reason_names_the_deciding_rule(self):
        info = {'a': self.base(published='2023-01-01'), 'b': self.base(published='2025-01-01')}
        self.assertEqual(plan.choose_survivor(['b', 'a'], info), ('a', ['b'], 'published first'))
        info['b']['published'] = '2023-01-01'
        info['b']['segments'] = 500
        self.assertEqual(plan.choose_survivor(['a', 'b'], info)[2], 'longer transcript')

    def test_deleted_from_youtube_loses(self):
        info = {'a': self.base(on_youtube=False, published='2020-01-01'), 'b': self.base()}
        self.assertEqual(plan.choose_survivor(['a', 'b'], info)[0], 'b')

    def test_merged_speakers_keeps_survivor_order_and_adds_only_new(self):
        src = {'a': 'Ray Kurzweil', 'b': 'Joe Rogan, Ray Kurzweil'}
        self.assertEqual(plan.merged_speakers(['a', 'b'], 'a', src), 'Ray Kurzweil, Joe Rogan')

    def test_merged_speakers_treats_name_variants_as_one_person(self):
        src = {'a': 'Yuval Noah Harari', 'b': 'Yuval Harari, Lex Fridman', 'c': 'Amy E. Lerman'}
        self.assertEqual(plan.merged_speakers(['a', 'b'], 'a', src), 'Yuval Noah Harari, Lex Fridman')
        self.assertEqual(plan.merged_speakers(['c', 'x'], 'x', {'x': 'Amy Lerman', 'c': 'Amy E. Lerman'}), 'Amy Lerman')
        self.assertEqual(plan.person_key('Álvaro  de la Peña'), ('alvaro', 'pena'))


class BunnyDeletions(unittest.TestCase):
    items = [{'title': 'aaaaaaaaaaa'}, {'title': 'Test Video bbbbbbbbbbb'}, {'title': 'Failed upload — HR'},
             {'title': 'ccccccccccc'}]

    def test_selects_exact_titles_and_reports_missing(self):
        chosen, missing, blocking = plan.select_bunny_deletions(
            ['aaaaaaaaaaa', 'Failed upload — HR', 'zzzzzzzzzzz'], self.items, set())
        self.assertEqual([i['title'] for i in chosen], ['aaaaaaaaaaa', 'Failed upload — HR'])
        self.assertEqual((missing, blocking), (['zzzzzzzzzzz'], []))

    def test_a_transcribed_video_blocks_even_inside_a_prefixed_title(self):
        self.assertEqual(plan.select_bunny_deletions(['Test Video bbbbbbbbbbb'], self.items, {'bbbbbbbbbbb'})[2],
                         ['bbbbbbbbbbb'])
        self.assertEqual(plan.select_bunny_deletions(['ccccccccccc'], self.items, {'ccccccccccc'})[2], ['ccccccccccc'])


class PurgeRows(unittest.TestCase):
    def test_keeps_only_video_ids_and_blocks_live_or_owned_videos(self):
        self.assertEqual(plan.purge_targets(['bbbbbbbbbbb', 'aaaaaaaaaaa', 'not an id', 'aaaaaaaaaaa'], set(), {}),
                         (['aaaaaaaaaaa', 'bbbbbbbbbbb'], []))
        self.assertEqual(plan.purge_targets(['aaaaaaaaaaa', 'bbbbbbbbbbb'], {'aaaaaaaaaaa'}, {'bbbbbbbbbbb': 2})[1],
                         ['aaaaaaaaaaa', 'bbbbbbbbbbb'])


class Coverage(unittest.TestCase):
    def test_replacement_needs_a_real_gain(self):
        self.assertEqual(plan.coverage(400, 800), 0.5)
        self.assertIsNone(plan.coverage(400, None))
        self.assertTrue(plan.should_replace_transcript(0.2, 0.95))
        self.assertFalse(plan.should_replace_transcript(0.72, 0.75))
        self.assertFalse(plan.should_replace_transcript(0.5, None))


if __name__ == '__main__':
    unittest.main()
