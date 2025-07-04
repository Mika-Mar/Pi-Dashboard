cmake_minimum_required(VERSION 3.21)

project(unit-test VERSION 0.1 LANGUAGES CXX)

enable_testing()

set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(Qt6 REQUIRED COMPONENTS QuickTest)

qt_standard_project_setup(REQUIRES 6.5)

qt_add_executable(Test

    main.cpp
    main.cpp
)
add_test(NAME Test COMMAND Test)

# no need to copy around qml test files for shadow builds - just set the respective define
add_definitions(-DQUICK_TEST_SOURCE_DIR="${CMAKE_CURRENT_SOURCE_DIR}")

file(GLOB_RECURSE QML_FILES *.qml)
add_custom_target(qmlfiles SOURCES ${QML_FILES})

set_target_properties(Test PROPERTIES
    MACOSX_BUNDLE FALSE
    WIN32_EXECUTABLE FALSE
)

target_link_libraries(Test
    PRIVATE Qt6::Qml
    PRIVATE Qt6::QuickTest
)
