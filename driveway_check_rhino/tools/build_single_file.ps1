# Regenerates ../driveway_checker.cs from src/. That file is the master the
# Grasshopper Script component actually reads (its `script` pin is fed a path),
# while src/ is the source of truth and what the #load-based test runs use.
# Keeping the two in step by hand is how they silently drift, so run this after
# every src/ change, then trigger a GH recompute.
#
#   powershell -ExecutionPolicy Bypass -File tools\build_single_file.ps1
#
# The output is a VERBATIM concatenation of src/ -- bodies are copied
# unchanged, and the only edit is hoisting each file's `using` lines into one
# block at the top. Cross-namespace references (Part 1 naming Shared's types,
# and both naming Core's) resolve because file-scope usings apply to every
# namespace declared in the file, so no name rewriting is needed. Verbatim
# matters: it means a drift check is a plain text comparison.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# Dependency order. Core first -- it is pure NTS with no RhinoCommon, which is
# what lets it be #load-ed and tested standalone with no Rhino round trip.
$sources = @(
    'src\Part1_Identify\Core\SkeletonGraph.cs'
    'src\Part1_Identify\Core\BoundaryArc.cs'
    'src\Part1_Identify\Core\MedianFinder.cs'
    'src\Part1_Identify\Core\SkeletonExtractor.cs'
    'src\Part1_Identify\Core\WidthProfile.cs'
    'src\Part1_Identify\Core\SkeletonPruning.cs'
    'src\Part1_Identify\Core\RunSegmenter.cs'
    'src\Part1_Identify\Core\Classifier.cs'
    'src\Part1_Identify\Core\ApronFinder.cs'

    # Rhino <-> NTS plumbing that every part needs
    'src\Shared\PolylineCoordinates.cs'
    'src\Shared\BrepToPolygon.cs'
    'src\Shared\CurveToLineString.cs'

    # Part 1, the RhinoCommon-facing half
    'src\Part1_Identify\BrepArcs.cs'
    'src\Part1_Identify\IdentifyRun.cs'

    'src\Part1_Identify\RegionBuilder.cs'
    'src\Part1_Identify\SkeletonPreview.cs'

    # Part 2 -- measures what Part 1 identified
    'src\Part2_Dimensions\DimensionRun.cs'

    # Part 3 (check against code) gets added here -- see its folder README.
)

# Grasshopper.Kernel is not referenced by src/ but the script component's own
# host context expects it; System.Drawing likewise predates the colour outputs
# being dropped. Both are kept because the live component compiles with them.
$extraUsings = @('using System.Drawing;', 'using Grasshopper.Kernel;')

$usings = [System.Collections.Generic.SortedSet[string]]::new()
foreach ($u in $extraUsings) { [void]$usings.Add($u) }

$bodies = [System.Collections.Generic.List[string]]::new()
foreach ($rel in $sources) {
    $path = Join-Path $root $rel
    if (-not (Test-Path $path)) { throw "missing source file: $rel" }

    $kept = [System.Collections.Generic.List[string]]::new()
        # -Encoding utf8 is required: Windows PowerShell 5.1 reads as the system
    # ANSI codepage by default, which mangles any non-ASCII byte in a source
    # file (a warning glyph came through as three junk characters and showed up
    # as drift between src/ and the generated master).
    foreach ($line in (Get-Content -LiteralPath $path -Encoding utf8)) {
        $trimmed = $line.TrimStart()
        if ($trimmed.StartsWith('using ') -and $line.TrimEnd().EndsWith(';')) {
            [void]$usings.Add($line.Trim())
        } elseif ($trimmed.StartsWith('using ') -and -not $trimmed.StartsWith('using (')) {
            # A using with a trailing comment does not end in ';', so it is not
            # recognised as one and stays in the body -- where it lands after an
            # earlier file's namespace and the compiler rejects the whole build
            # with "a using clause must precede all other elements". That has
            # happened once. Fail here instead of emitting a broken master file.
            throw "$rel line $($kept.Count + 1): a using directive must be on its own line ending in ';', with any comment above it, or it cannot be hoisted -- got: $trimmed"
        } else {
            [void]$kept.Add($line)
        }
    }
    $body = ($kept -join "`r`n").Trim("`r", "`n")
    [void]$bodies.Add("// ===== $($rel.Replace([char]92,[char]47)) =====`r`n$body")
}

$entry = (Get-Content -LiteralPath (Join-Path $root 'src\GhEntryPoint.csx')) -join "`r`n"
$entry = $entry.Trim("`r", "`n")

$header = @'
// GENERATED FILE -- do not edit. Regenerate with:
//   powershell -ExecutionPolicy Bypass -File tools\build_single_file.ps1
// Source of truth is src/; the GH entry point is src/GhEntryPoint.csx.
'@

$out = [System.Collections.Generic.List[string]]::new()
[void]$out.Add('#r "C:\Users\XUANB\.nuget\packages\nettopologysuite\2.5.0\lib\netstandard2.0\NetTopologySuite.dll"')
[void]$out.Add('')
[void]$out.Add($header)
[void]$out.Add('')
foreach ($u in $usings) { [void]$out.Add($u) }
[void]$out.Add('')
foreach ($b in $bodies) { [void]$out.Add($b); [void]$out.Add('') }
[void]$out.Add('// ===== GH entry point =====')
[void]$out.Add($entry)

$target = Join-Path $root 'driveway_checker.cs'
Set-Content -LiteralPath $target -Value ($out -join "`r`n") -Encoding utf8
Write-Host "regenerated driveway_checker.cs from $($sources.Count) source files"
