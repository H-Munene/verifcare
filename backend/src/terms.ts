// The terms of use and privacy notice each mobile app asks its users to accept (2026-09-26, the
// consent screen). Served by the API rather than built into the apps, so the wording can change
// without an app release; bumping a document's `version` asks every user of that app to accept
// again (terms_acceptances keeps one row per version accepted).
//
// Version 1 is a first draft written for the user's legal review (user decision: "draft it,
// marked v1"), grounded in the Kenya Data Protection Act, 2019 and in what this system actually
// does - each factual statement below matches the implementation (hosting region, retention,
// who sees what). Before production, the data protection contact below must be replaced with a
// real address, and the text reviewed by a qualified advisor.

export type TermsDocumentType = 'caregiver' | 'family_member';

export interface TermsSection {
  heading: string;
  paragraphs: string[];
}

export interface TermsDocument {
  document: TermsDocumentType;
  version: string;
  title: string;
  effectiveDate: string;
  sections: TermsSection[];
}

const rights: TermsSection = {
  heading: 'Your rights',
  paragraphs: [
    'Under the Kenya Data Protection Act, 2019 you can ask to see the personal data we hold about you, have it corrected or deleted, object to how it is used, and withdraw your consent at any time. Withdrawing consent does not affect anything done before you withdrew it, but you will not be able to keep using the app.',
    'If you are not satisfied with how we handle your data, you can complain to the Office of the Data Protection Commissioner (ODPC).',
  ],
};

const hosting: TermsSection = {
  heading: 'Where your data is kept',
  paragraphs: [
    'Your data is stored on Amazon Web Services in the European Union (Ireland), encrypted in storage and in transit. Photos are compared using Amazon Rekognition, and maps are provided by Google Maps. These providers process data only to provide these services to Mzazi Care.',
  ],
};

const contact: TermsSection = {
  heading: 'Contact',
  paragraphs: [
    'For any question about your data or these terms, or to use your rights, contact your Mzazi Care supervisor, who will pass your request to our data protection contact.',
  ],
};

const caregiverTerms: TermsDocument = {
  document: 'caregiver',
  version: '1',
  title: 'Terms of Use and Privacy Notice',
  effectiveDate: '2026-09-26',
  sections: [
    {
      heading: 'About this app',
      paragraphs: [
        'Mzazi Care connects caregivers with the families of older people who need care at home. As a caregiver you use this app to see your visits, check in and out, record the care you give, and record visit audio where it is switched on.',
      ],
    },
    {
      heading: 'What we collect',
      paragraphs: [
        'Your account details: your name, email address and phone number.',
        'Your photo, taken when you are registered, and a new photo at every check-in, so we can confirm that the right caregiver is at the visit.',
        "Your location when you check in and check out, to confirm you are at the dependant's home. We do not track your location between visits.",
        'What happens on each visit: check-in and check-out times, the care tasks you record, and your notes.',
        'Audio you record during a visit, for dependants whose family has switched on cognitive monitoring. It is used to look for early signs of memory decline.',
      ],
    },
    {
      heading: 'Why we collect it',
      paragraphs: [
        'To confirm that visits happen as scheduled and by the right person, to keep dependants safe, to let supervisors and families follow the care given, and to alert a supervisor when a visit is missed.',
      ],
    },
    {
      heading: 'Who can see it',
      paragraphs: [
        "Mzazi Care supervisors can see your details, photos and visit records. A dependant's family members can see your name, your visit times and the care recorded on their dependant's visits. They cannot see your photo, your phone number or your email address.",
      ],
    },
    {
      heading: 'How long we keep it',
      paragraphs: [
        'Your check-in photos are deleted as soon as they have been compared with your registered photo. Your registered photo is kept while you work with Mzazi Care and deleted when your account is deactivated. Visit audio is deleted after 90 days. Visit records are kept as part of the care history.',
      ],
    },
    hosting,
    rights,
    contact,
    {
      heading: 'Accepting these terms',
      paragraphs: [
        'By tapping Accept you confirm that you have read this notice and agree to these terms, including the use of your photo and location described above. If you decline, the app will close and you will be asked again the next time you open it.',
      ],
    },
  ],
};

const familyMemberTerms: TermsDocument = {
  document: 'family_member',
  version: '1',
  title: 'Terms of Use and Privacy Notice',
  effectiveDate: '2026-09-26',
  sections: [
    {
      heading: 'About this app',
      paragraphs: [
        'Mzazi Care connects the families of older people who need care at home with trained caregivers. As a family member you use this app to register a dependant, follow their visits and the care given, and stay in touch with the rest of their family on Mzazi Care.',
      ],
    },
    {
      heading: 'What we collect',
      paragraphs: [
        'Your account details: your name, email address and phone number, and your identity document where one was recorded when you were registered.',
        'Details you give us about a dependant: their name, date of birth, gender, home address and the exact location of their home, their main health condition, and their photo.',
        "Visit records for your dependants: check-in and check-out times, the care tasks recorded, and caregivers' notes. For dependants with cognitive monitoring switched on, audio recorded during visits, used to look for early signs of memory decline.",
      ],
    },
    {
      heading: "Your dependant's consent",
      paragraphs: [
        'By registering or managing a dependant you confirm that you are authorised to share their details with Mzazi Care and, where they cannot give consent themselves, to consent on their behalf to their photo being used to confirm who a caregiver is visiting and, if you switch it on, to cognitive monitoring.',
      ],
    },
    {
      heading: 'Why we collect it',
      paragraphs: [
        'To arrange and verify care visits, to make sure caregivers visit the right person at the right home, to let you and your family follow the care given, and to alert a supervisor when a visit is missed.',
      ],
    },
    {
      heading: 'Who can see it',
      paragraphs: [
        "Mzazi Care supervisors can see everything described above. A caregiver assigned to a dependant can see what they need for the visit: the dependant's name, home location, care plan and photo. The other family members linked to the same dependant can see your name, relationship, phone number and email address, so you can coordinate care. They cannot see your identity document.",
      ],
    },
    {
      heading: 'How long we keep it',
      paragraphs: [
        "A dependant's photo is kept while they receive care and deleted when they are deactivated. Visit audio is deleted after 90 days. Visit records are kept as part of the care history.",
      ],
    },
    hosting,
    rights,
    contact,
    {
      heading: 'Accepting these terms',
      paragraphs: [
        'By tapping Accept you confirm that you have read this notice and agree to these terms. If you decline, the app will close and you will be asked again the next time you open it.',
      ],
    },
  ],
};

/** The current document for an app's users - the one they must have accepted to use it. */
export const CURRENT_TERMS: Record<TermsDocumentType, TermsDocument> = {
  caregiver: caregiverTerms,
  family_member: familyMemberTerms,
};
