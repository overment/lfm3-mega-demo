"""System prompts and language lists from the LFM3-Omni-2B model card."""

# Speech output locales (TTS and speech chat)
SPEECH_LOCALES = [
    "American English",
    "British English",
    "Arabic",
    "Chinese",
    "Danish",
    "Dutch",
    "Finnish",
    "French",
    "German",
    "Greek",
    "Hebrew",
    "Italian",
    "Japanese",
    "Korean",
    "Polish",
    "Portuguese",
    "Spanish",
    "Swedish",
    "Turkish",
]

# Speech input languages (ASR): the speech locales with one English
ASR_LANGUAGES = ["English"] + [
    name for name in SPEECH_LOCALES if not name.endswith("English")
]

# Text languages (translation targets)
TEXT_LANGUAGES = [
    "English",
    "Arabic",
    "Chinese",
    "French",
    "German",
    "Hindi",
    "Indonesian",
    "Italian",
    "Japanese",
    "Korean",
    "Polish",
    "Portuguese",
    "Russian",
    "Spanish",
    "Thai",
    "Vietnamese",
]

VOICES = ["female", "male"]

RESPOND_TEXT = "Respond with text."
RESPOND_SPEECH = "Respond with interleaved text and audio."


def respond(speak: bool) -> str:
    return RESPOND_SPEECH if speak else RESPOND_TEXT


def talk_system(speak: bool) -> str:
    return respond(speak)


def look_system(kind: str, listen: bool, speak: bool) -> str:
    if kind == "video" and listen:
        base = "Answer questions about the video using what you see and hear."
    elif kind == "video":
        base = "Answer questions about the provided video. Base every answer only on what can be seen."
    else:
        base = "Answer questions about the provided image. Base every answer only on what can be seen."
    return f"{base} {respond(speak)}"


def asr_system(language: str) -> str:
    return f"Perform ASR in {language}."


def translate_system(source: str, target: str) -> str:
    return f"Please translate the following spoken {source} into {target} text."


def tts_system(locale: str, voice: str) -> str:
    return f"Perform TTS in {locale} using a {voice} voice."
