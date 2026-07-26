from .help_command import help_command
from .send_command import send_command
from .cmd_command import cmd_command
from .respawn_command import respawn_command
from .restart_command import restart_command
from .move_command import move_command, jump_command, stop_command, goto_command, follow_command
from .action_command import leftclick_command, rightclick_command, look_command, cancel_command, sneak_command, drop_command, dropall_command, slot_command
from .test_command import test_command


def register_all():
    """向 CommandManager 注册全部命令。"""
    from command_manager import CommandManager
    CommandManager.register(help_command)
    CommandManager.register(send_command)
    CommandManager.register(cmd_command)
    CommandManager.register(respawn_command)
    CommandManager.register(restart_command)
    CommandManager.register(move_command)
    CommandManager.register(jump_command)
    CommandManager.register(stop_command)
    CommandManager.register(goto_command)
    CommandManager.register(follow_command)
    CommandManager.register(leftclick_command)
    CommandManager.register(rightclick_command)
    CommandManager.register(look_command)
    CommandManager.register(cancel_command)
    CommandManager.register(sneak_command)
    CommandManager.register(drop_command)
    CommandManager.register(dropall_command)
    CommandManager.register(test_command)
    CommandManager.register(slot_command)
