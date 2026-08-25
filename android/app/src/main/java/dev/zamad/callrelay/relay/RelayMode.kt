package dev.zamad.callrelay.relay

enum class RelayMode(val wireValue: String) {
    FULL_DUPLEX("full_duplex"),
    LISTEN("listen"),
    TALK("talk"),
    ;

    companion object {
        fun fromWire(value: String?): RelayMode = entries.firstOrNull { it.wireValue == value } ?: FULL_DUPLEX
    }
}
