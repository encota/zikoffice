// Registro delle icone usate dall'interfaccia.
// Importiamo solo quelle necessarie, così il bundle resta piccolo.
import {
  createElement,
  Presentation, LayoutTemplate, ImagePlus, Play, MonitorPlay, StickyNote, BringToFront, SendToBack, LayoutDashboard, WandSparkles, Palette, Circle, Triangle, ArrowRight, Star, Diamond, Slash, LayoutGrid, Ratio, Heading,
  SquareTerminal, Sparkles, RotateCcw, RotateCw, ArrowUp, ArrowDown, ScanText, Languages, FileType, BoxSelect, FileSearch, FilterX, Funnel, FileDown, FileSpreadsheet, ArrowDownAZ, ArrowDownZA, BetweenHorizontalStart, BetweenVerticalStart, Check, ClipboardType, CopyPlus, Eye, EyeOff, Frame, Grid2x2, MoveHorizontal, MoveVertical, PanelLeft, PanelTopClose, Pencil, SaveAll, Square, SquareX, TableCellsSplit,
  AArrowDown, AArrowUp, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart, ArrowDownWideNarrow, ArrowUpDown, Baseline, Bold, BookOpen,
  BookOpenText, Calculator, ChartColumn, ChartLine, ChartPie, ChevronDown, ChevronUp, Clock,
  ClipboardPaste, Columns2, Columns3, Copy, Eraser, Euro, FileDiff, FilePlus2, FileText,
  Filter, FolderOpen, Footprints, Grid3x3, Hash, Highlighter, Image, IndentDecrease,
  IndentIncrease, Italic, Layers, Link, List, ListFilter, ListOrdered, ListTree, Mail, Merge,
  MessageSquarePlus, Minus, Monitor, Moon, MousePointer2, Omega, PaintBucket, Paintbrush,
  PanelBottom, PanelTop, Percent, Pilcrow, Plus, Printer, RectangleHorizontal,
  RectangleVertical, Redo2, RefreshCw, Replace, Rows3, Ruler, Save, Scaling, Scissors,
  Search, SeparatorHorizontal, Settings, Shapes, Share2, Sheet, Sigma, Snowflake, SpellCheck, Stamp,
  SquareDashed, SquareFunction, Strikethrough, Subscript, Sun, Superscript, Table,
  TableCellsMerge, TableProperties, Tag, TextAlignCenter, TextAlignEnd, TextAlignJustify,
  FileCode, TextAlignStart, TextCursorInput, Trash2, Type, Underline, Undo2, WrapText, X, ZoomIn,
} from "lucide";

const registry = {
  Presentation, LayoutTemplate, ImagePlus, Play, MonitorPlay, StickyNote, BringToFront, SendToBack, LayoutDashboard, WandSparkles, Palette, Circle, Triangle, ArrowRight, Star, Diamond, Slash, LayoutGrid, Ratio, Heading,
  FileCode, SquareTerminal, Sparkles, RotateCcw, RotateCw, ArrowUp, ArrowDown, ScanText, Languages, FileType, BoxSelect, FileSearch, FilterX, Funnel, FileDown, FileSpreadsheet, ArrowDownAZ, ArrowDownZA, BetweenHorizontalStart, BetweenVerticalStart, Check, ClipboardType, CopyPlus, Eye, EyeOff, Frame, Grid2x2, MoveHorizontal, MoveVertical, PanelLeft, PanelTopClose, Pencil, SaveAll, Square, SquareX, TableCellsSplit,
  AArrowDown, AArrowUp, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart, ArrowDownWideNarrow, ArrowUpDown, Baseline, Bold, BookOpen,
  BookOpenText, Calculator, ChartColumn, ChartLine, ChartPie, ChevronDown, ChevronUp, Clock,
  ClipboardPaste, Columns2, Columns3, Copy, Eraser, Euro, FileDiff, FilePlus2, FileText,
  Filter, FolderOpen, Footprints, Grid3x3, Hash, Highlighter, Image, IndentDecrease,
  IndentIncrease, Italic, Layers, Link, List, ListFilter, ListOrdered, ListTree, Mail, Merge,
  MessageSquarePlus, Minus, Monitor, Moon, MousePointer2, Omega, PaintBucket, Paintbrush,
  PanelBottom, PanelTop, Percent, Pilcrow, Plus, Printer, RectangleHorizontal,
  RectangleVertical, Redo2, RefreshCw, Replace, Rows3, Ruler, Save, Scaling, Scissors,
  Search, SeparatorHorizontal, Settings, Shapes, Share2, Sheet, Sigma, Snowflake, SpellCheck, Stamp,
  SquareDashed, SquareFunction, Strikethrough, Subscript, Sun, Superscript, Table,
  TableCellsMerge, TableProperties, Tag, TextAlignCenter, TextAlignEnd, TextAlignJustify,
  TextAlignStart, TextCursorInput, Trash2, Type, Underline, Undo2, WrapText, X, ZoomIn,
};

export type IconName = keyof typeof registry;

export function icon(name: IconName, size = 16, strokeWidth = 1.75): SVGElement {
  const el = createElement(registry[name], {
    width: size,
    height: size,
    "stroke-width": strokeWidth,
  });
  el.classList.add("icon");
  el.setAttribute("aria-hidden", "true");
  return el;
}
