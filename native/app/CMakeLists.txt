# The native app: ampcore's chain inside JUCE (epic #38, milestone 2).
#
# Built as a plugin with a Standalone format, so the AU and VST3 of
# milestone 4 come from this same code by adding to FORMATS rather than by
# writing a second app.
#
# JUCE 9 is used under its AGPLv3 option, the licence this project is under.
# It is fetched as a release tarball checked against its hash, into
# native/.deps rather than the build directory, so a fresh build does not
# download it again.
#
#   cmake -B build -G Ninja && cmake --build build      (CMake 3.22 or later)
#   open build/Amp_artefacts/Release/Standalone/Amp.app

cmake_minimum_required(VERSION 3.22)
set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "Oldest macOS to run on")
project(AmpApp VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release)
endif()

include(FetchContent)
set(FETCHCONTENT_BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../.deps" CACHE PATH "" FORCE)
FetchContent_Declare(juce
  URL https://github.com/juce-framework/JUCE/archive/refs/tags/9.0.4.tar.gz
  URL_HASH SHA256=e2bee25d5c776118aea550ad168a3dc9520c0669a79bd9f5a72b9f404ee1c40a
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
FetchContent_MakeAvailable(juce)

# The DSP, with its own flags — no fast-math, no FMA contraction — kept on
# its own target so JUCE's recommended flags never reach it.
add_subdirectory(../ampcore ampcore EXCLUDE_FROM_ALL)

juce_add_plugin(Amp
  PRODUCT_NAME "Amp"
  COMPANY_NAME "Theodore Van Rooy"
  BUNDLE_ID com.greentheo.amp
  FORMATS Standalone
  PLUGIN_MANUFACTURER_CODE Gthe
  PLUGIN_CODE Amp1
  IS_SYNTH FALSE
  NEEDS_MIDI_INPUT TRUE
  NEEDS_MIDI_OUTPUT FALSE
  MICROPHONE_PERMISSION_ENABLED TRUE
  MICROPHONE_PERMISSION_TEXT "Amp plays your guitar, which arrives through an audio input."
  COPY_PLUGIN_AFTER_BUILD FALSE)

target_sources(Amp PRIVATE src/Processor.cpp src/Editor.cpp)

target_compile_definitions(Amp PUBLIC
  JUCE_WEB_BROWSER=1
  JUCE_USE_CURL=0
  JUCE_VST3_CAN_REPLACE_VST2=0)

target_link_libraries(Amp
  PRIVATE
    ampcore
    juce::juce_audio_utils
    juce::juce_gui_extra
  PUBLIC
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags)

# The browser's UI, copied into the bundle for the WebView to serve. The
# page and its scripts only — not the calibration audio, the tools or the
# native sources. Its own target, run on every build: as a post-build step it
# only ran when the binary relinked, which an edit to the page never causes.
# AMP_WEB_ROOT overrides the copy at run time, for editing the page live.
set(AMP_WEB_SOURCE "${CMAKE_CURRENT_SOURCE_DIR}/../..")
set(AMP_WEB_DEST "$<TARGET_BUNDLE_CONTENT_DIR:Amp_Standalone>/Resources/web")
add_custom_target(AmpWebUI ALL
  COMMAND ${CMAKE_COMMAND} -E rm -rf "${AMP_WEB_DEST}"
  COMMAND ${CMAKE_COMMAND} -E make_directory "${AMP_WEB_DEST}"
  COMMAND ${CMAKE_COMMAND} -E copy "${AMP_WEB_SOURCE}/index.html" "${AMP_WEB_DEST}/"
  COMMAND ${CMAKE_COMMAND} -E copy_directory "${AMP_WEB_SOURCE}/css" "${AMP_WEB_DEST}/css"
  COMMAND ${CMAKE_COMMAND} -E copy_directory "${AMP_WEB_SOURCE}/js" "${AMP_WEB_DEST}/js"
  COMMENT "Copying the web UI into the app bundle"
  VERBATIM)
add_dependencies(AmpWebUI Amp_Standalone)

# Signing. Left empty, the build is ad-hoc signed, which macOS treats as a
# new app after every rebuild and asks for the microphone again. Name an
# identity from `security find-identity -v -p codesigning` and the
# permission sticks. Its 40-character hash is safer than its name when two
# certificates share a name, as one person's do across two teams:
#
#   cmake -B build -DAMP_CODESIGN_IDENTITY=<hash or "Apple Development: Name (XXXXXXXXXX)">
#
# Signing is the last step, after the page is copied in, so the signature
# seals the page too.
set(AMP_CODESIGN_IDENTITY "" CACHE STRING "Identity to sign Amp.app with; empty for ad-hoc")
if(AMP_CODESIGN_IDENTITY)
  add_custom_target(AmpSign ALL
    COMMAND codesign --force --timestamp=none --sign "${AMP_CODESIGN_IDENTITY}" "$<TARGET_BUNDLE_DIR:Amp_Standalone>"
    COMMENT "Signing Amp.app"
    VERBATIM)
  add_dependencies(AmpSign AmpWebUI)
endif()
