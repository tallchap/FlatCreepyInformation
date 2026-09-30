"""Anonymous role labels must not force unsupported named attribution."""
import unittest

from luna_batch_qa import validate_speaker


class AnonymousSpeakerTests(unittest.TestCase):
    def test_recorded_combined_name_and_unknown_interviewer(self):
        label = 'Jaan Tallinn and unidentified interviewer'
        self.assertEqual(validate_speaker(label, ['Jaan Tallinn']), label)

    def test_explicit_unknown_roles_and_plurals(self):
        for unknown in ('unidentified', 'unknown', 'unnamed'):
            for role in ('speaker', 'interviewer', 'moderator', 'panelist'):
                for plural in ('', 's', '(s)'):
                    label = f'{unknown} {role}{plural}'
                    with self.subTest(label=label):
                        self.assertEqual(validate_speaker(label, []), label)
        self.assertEqual(validate_speaker('the unidentified moderator', []), 'the unidentified moderator')
        self.assertEqual(validate_speaker('Unknown  Interviewer', []), 'Unknown  Interviewer')

    def test_unknown_role_does_not_authorize_a_personal_name(self):
        invalid = ['Unknown interviewer John Smith', 'Unidentified moderator (Jane Doe)', 'Jaan Tallinn and Invented Person', 'Jaan Tallinn and unknown interviewer Jane Doe', 'Unknown interviewer and Invented Person', 'Identified speaker', 'interviewer', 'unknown', 'unidentified leader']
        for label in invalid:
            with self.subTest(label=label):
                with self.assertRaises(ValueError):
                    validate_speaker(label, ['Jaan Tallinn'])

    def test_provided_named_speakers_remain_supported(self):
        self.assertEqual(validate_speaker('Mark Sagar', ['will.i.am, Mark Sagar, Robert Downey Jr.']), 'Mark Sagar')
        with self.assertRaises(ValueError):
            validate_speaker('New Person and unidentified panelists', ['Mark Sagar'])


if __name__ == '__main__':
    unittest.main()
